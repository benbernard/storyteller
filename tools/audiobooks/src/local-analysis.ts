import { z } from 'zod';
import { PROMPT, rosterAt, validateAnalysis } from './analysis.js';
import { sourceUnits, restoreUnits, unitAnalysisSchema, semanticLabelSchema, wireLabelSchema, semanticBoundaryEnds } from './analysis-units.js';
import { type Analysis, type Chapter, type Cast } from './schema.js';
import { Store, fingerprint } from './store.js';
import { MacClient } from './mac-client.js';
const coordinates = { first: z.number().int().nonnegative(), last: z.number().int().nonnegative() };
const rangeSchema = semanticLabelSchema.extend(coordinates).strict();
export const localResponseSchema = unitAnalysisSchema.omit({ units: true }).extend({ ranges: z.array(rangeSchema).min(1) }).strict();
const localWireSchema = localResponseSchema.extend({ ranges: z.array(wireLabelSchema.extend({ ...coordinates, parts: z.array(wireLabelSchema.extend({ end: z.number().int().positive() }).strict()).min(1).nullable() }).strict()).min(1) }).strict();
export const LOCAL_PROMPT = PROMPT + `
Return ONLY valid JSON, without markdown or commentary. The input supplies numbered exact source units. Do not copy or rewrite their text.
Return characters and aliasUpdates with evidenceUnit (a unit number) instead of evidence. Return ranges instead of spans. Each range contains first, last (inclusive unit numbers), kind, speaker, certainty, confidence, reason, nullable section, nullable parts. Never combine author-note and story units in one range. A homogeneous range has parts=null. If one unit mixes story and author commentary, use a single-unit range (first=last) and ordered parts with independent labels and exclusive UTF-16 end offsets from boundaryEnds, ending at utf16Length. Cover every character and whitespace. Parent labels are ignored when parts are present. Never tag mixed content wholly as author-note; split exact parts or use section=null if uncertain.
Ranges must cover every unit exactly once, in order, starting at 0 and ending at the final unit. Combine adjacent units only when their labels agree. Keep dialogue units separate from the surrounding narrator prose. Use stable roster IDs for known people. Do not redeclare existing characters.
Only quoted spoken dialogue uses a character voice. Narrator reads narration, quoted titles, epigraphs, thoughts and system messages. A speaker must be known from source evidence; uncertain dialogue uses anonymous. Do not invent names. For voice tags, use male/female and adult/child only when supported by the source; use lowercase tags such as warm, bright, rough, precise, young, older where appropriate. Keep summary under 3000 characters.
Schema: ` + JSON.stringify(z.toJSONSchema(localWireSchema, { target: 'draft-7' }));
export function restoreRanges(value: unknown, units: string[]) {
  const data = localResponseSchema.parse(value); let expected = 0;
  const labels: z.infer<typeof unitAnalysisSchema>['units'] = [];
  for (const { first, last, ...label } of data.ranges) {
    if (first !== expected || last < first || last >= units.length) throw new Error(`Ranges must cover units in order; expected ${expected}`);
    if (label.parts && first !== last) throw new Error('Semantic parts require a single-unit range; split mixed ranges by unit');
    for (let unit = first; unit <= last; unit++) labels.push({ ...label, unit });
    expected = last + 1;
  }
  if (expected !== units.length) throw new Error(`Uncovered unit ${expected}`);
  const raw = restoreUnits({ characters: data.characters, aliasUpdates: data.aliasUpdates, units: labels, summary: data.summary }, units);
  return { ...raw, spans: raw.spans.map(label => {
    const spoken = label.kind === 'dialogue' && /^[“"]/.test(label.text.trimStart());
    return { ...label, ...(spoken ? label.speaker === 'anonymous' ? { certainty: 'uncertain' as const } : {}
      : { speaker: 'narrator', kind: 'prose' as const, certainty: 'attributed' as const }) };
  }) };
}
export async function analyzeLocal(mac: MacClient, store: Store, chapter: Chapter, cast: Cast, context: string, cancelled: () => boolean): Promise<Analysis> {
  const units = sourceUnits(chapter.text);
  const dependency = fingerprint({ source: chapter.contentHash, roster: rosterAt(cast, chapter.sequence), context, prompt: LOCAL_PROMPT, model: 'qwen-text', revision: 'ba63a5141812f9870287df53341123a71ba41433' });
  let validationError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const path = `local-analysis-attempts/${dependency}-${attempt}`;
    const saved = await store.read<Analysis>(`${path}/validated.json`); if (saved) return saved;
    const input = { text: JSON.stringify({ units: units.map((text, unit) => ({ unit, text, utf16Length: text.length, boundaryEnds: semanticBoundaryEnds(text) })), roster: rosterAt(cast, chapter.sequence), previousContext: context, validationError }), system: LOCAL_PROMPT, max_tokens: 12000, temperature: 0.2, seed: 810 + attempt };
    const text = await mac.text(input, store, path, cancelled);
    try {
      const raw = restoreRanges(JSON.parse(text.trim()), units);
      raw.characters = raw.characters.filter(candidate => {
        const known = cast.members.find(c => c.id === candidate.id);
        if (known && (known.name === candidate.name || known.aliases.some(a => a.name === candidate.name))) return false;
        return raw.spans.some(s => s.speaker === candidate.id && s.certainty === 'attributed');
      });
      const spans = validateAnalysis(raw, chapter, cast);
      const analysis: Analysis = { schemaVersion: 1, source: chapter.contentHash, fingerprint: dependency, model: 'qwen-text', promptVersion: 'local-ranges-semantic-sections-v3', spans, characters: raw.characters, aliasUpdates: raw.aliasUpdates, summary: raw.summary };
      await store.write(`${path}/validated.json`, analysis); return analysis;
    } catch (error) { validationError = error instanceof z.ZodError ? 'JSON did not match the required schema' : (error as Error).message; await store.write(`${path}/validation-error.json`, { error: validationError }); }
  }
  throw new Error(`Chapter analysis needs review after three validation attempts: ${validationError}`);
}
