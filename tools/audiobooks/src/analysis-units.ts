import { z } from 'zod';
import { analysisSchema, candidateSchema, type RawAnalysis } from './schema.js';

// Parsing old cached responses remains valid; newly requested wire labels use
// required nullable section below, so constrained decoding cannot omit it.
export const unitLabelSchema = analysisSchema.shape.spans.element.omit({ text: true, section: true }).extend({
  section: z.literal('author-note').nullable().optional(),
}).strict();
export const wireLabelSchema = unitLabelSchema.extend({ section: z.literal('author-note').nullable() }).strict();
export const semanticLabelSchema = unitLabelSchema.extend({ parts: z.array(unitLabelSchema.extend({
  end: z.number().int().positive(),
}).strict()).min(1).nullable().optional() }).strict();

/** Restore exact source fragments; homogeneous legacy labels retain their shape. */
export function restoreSemanticParts(text: string, value: unknown, unit: number): RawAnalysis['spans'] {
  const { parts, ...parent } = semanticLabelSchema.parse(value);
  const boundaries = new Set(semanticBoundaryEnds(text));
  let start = 0;
  const spans = (parts ?? [{ ...parent, end: text.length }]).map(({ end, section, ...label }) => {
    if (end <= start || end > text.length || !boundaries.has(end)
      || (/^[\uDC00-\uDFFF]$/.test(text[end] ?? '') && /[\uD800-\uDBFF]/.test(text[end - 1]!)))
      throw new Error(`Invalid semantic boundary at unit ${unit}`);
    const fragment = text.slice(start, end); start = end;
    // An explicit note heading after existing prose proves this label crosses
    // a possible section boundary. Keep ambiguous unsplit content audible;
    // the model may supply exact parts to mark only the commentary instead.
    const marker = /\bauthor(?:['’]s)?[\s-]+notes?\s*[:—-]/iu.exec(fragment);
    const mixed = marker && /[\p{L}\p{N}]/u.test(fragment.slice(0, marker.index));
    return { ...label, ...(section === 'author-note' && !mixed ? { section } : {}), text: fragment };
  });
  if (start !== text.length) throw new Error(`Semantic parts must cover source unit ${unit}`);
  return spans;
}

export function sourceUnits(text: string): string[] {
  const units: string[] = [];
  let position = 0;
  const prose = (value: string) => { for (const part of value.match(/[^\n]+(?:\n+|$)|\n+/gu) ?? []) units.push(part); };
  // Preserve quotation marks and every source byte; classification can still mark a quotation as thought or system text.
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '“' && text[start] !== '"') continue;
    let end = start + 1;
    let nestedCurly = 0;
    for (; end < text.length; end++) {
      // Royal Road can mix straight and curly opening marks in one continued
      // speech. A paragraph-opening quote is a continuation, not a nested pair.
      if ((text[end] === '"' || text[end] === '“') && /\n\s*\n[\t ]*$/.test(text.slice(start + 1, end)) && /\S/.test(text[end + 1] ?? '')) continue;
      // A typographic quotation inside straight-quoted speech is part of that
      // speech, not its end. Otherwise the closing inner quote strands spoken
      // words in a prose unit and can pull the following dialogue tag into speech.
      if (text[start] === '"' && text[end] === '“') { nestedCurly++; continue; }
      if (text[start] === '"' && nestedCurly > 0) {
        if (text[end] === '”') nestedCurly--;
        continue;
      }
      if (text[end] !== '”' && text[end] !== '"') continue;
      break;
    }
    if (end === text.length) break;
    prose(text.slice(position, start)); units.push(text.slice(start, end + 1)); position = end + 1; start = end;
  }
  prose(text.slice(position));
  for (let i = units.length - 1; i > 0; i--) if (!units[i]!.trim()) { units[i - 1] += units[i]!; units.splice(i, 1); }
  if (units.length > 1 && !units[0]!.trim()) { units[1] = units[0]! + units[1]!; units.shift(); }
  if (units.join('') !== text) throw new Error('Source unit coverage mismatch');
  return units;
}
export const unitAnalysisSchema = z.object({
  characters: z.array(candidateSchema.omit({ evidence: true }).extend({ evidenceUnit: z.number().int().nonnegative() }).strict()),
  aliasUpdates: z.array(z.object({ characterId: z.string(), name: z.string(), evidenceUnit: z.number().int().nonnegative() }).strict()),
  units: z.array(semanticLabelSchema.extend({ unit: z.number().int().nonnegative() }).strict()),
  summary: z.string().max(8000),
}).strict();
export const UNIT_PROMPT = `The chapter is supplied as numbered sourceUnits. Label EVERY unit exactly once in order, without copying its text. Return units with the matching unit number and its kind, speaker, certainty, confidence, reason, section. Section is author-note only for explicit author-to-reader commentary; otherwise null. Keep section independent from kind and speaker, and never mistake story prose, epigraphs, in-world articles, system messages or character statistics for author commentary. For a homogeneous unit use parts=null. If a unit mixes story and author commentary, return ordered parts with their own labels and exclusive UTF-16 end offsets chosen from boundaryEnds. The last end must equal utf16Length; cover every source character and whitespace exactly. Parent labels are ignored when parts are supplied. Never tag a mixed unit wholly as author-note; use exact parts, or section=null when uncertain. Use evidenceUnit for characters and aliasUpdates, pointing at an actual unit that establishes the character or new name. Whitespace-only units use narrator/prose. A quoted unit may be dialogue, thought, quotation, or system; classify using the whole chapter. Never invent or omit a unit. Use narrator for text outside spoken dialogue. The software restores exact source text from your labels.`;
export function restoreUnits(value: unknown, units: string[]): RawAnalysis {
  const data = unitAnalysisSchema.parse(value);
  if (data.units.length !== units.length || data.units.some((u, i) => u.unit !== i)) throw new Error('Unit labels must cover every source unit in order');
  const evidence = (index: number) => { const text = units[index]; if (!text) throw new Error('Evidence unit is outside chapter'); return text; };
  return analysisSchema.parse({ characters: data.characters.map(({ evidenceUnit, ...c }) => ({ ...c, evidence: evidence(evidenceUnit) })),
    aliasUpdates: data.aliasUpdates.map(({ evidenceUnit, ...a }) => ({ ...a, evidence: evidence(evidenceUnit) })),
    spans: data.units.flatMap(({ unit, ...label }) => restoreSemanticParts(units[unit]!, label, unit)), summary: data.summary });
}

// Required object keys let constrained decoding enforce complete coverage, instead
// of asking a model to count and reproduce a long array of numbered labels.
export function unitResponseSchema(count: number, semanticParts = false, texts?: readonly string[]): Record<string, unknown> {
  if (texts && texts.length !== count) throw new Error('Schema text count must match source unit count');
  const baseLabel = wireLabelSchema;
  const schema = semanticParts ? baseLabel.extend({ parts: z.array(baseLabel.extend({ end: z.number().int().positive() }).strict()).min(1).nullable() }).strict() : baseLabel;
  const label = z.toJSONSchema(schema, { target: 'draft-7' });
  const base = z.toJSONSchema(unitAnalysisSchema.omit({ units: true }), { target: 'draft-7' }) as Record<string, any>;
  const keys = Array.from({ length: count }, (_, i) => `unit_${i}`);
  const properties = Object.fromEntries(keys.map((key, i) => {
    if (!semanticParts || !texts) return [key, { $ref: '#/definitions/label' }];
    const part = baseLabel.extend({ end: z.number().int().positive().max(texts[i]!.length) }).strict();
    return [key, z.toJSONSchema(baseLabel.extend({ parts: z.array(part).min(1).nullable() }).strict(), { target: 'draft-7' })];
  }));
  return { ...base, definitions: { label }, required: [...base.required, 'labels'],
    properties: { ...base.properties, labels: { type: 'object', additionalProperties: false,
      required: keys, properties } } };
}
export function restoreUnitResponse(value: unknown, units: string[]): RawAnalysis {
  const data = z.object({ characters: unitAnalysisSchema.shape.characters, aliasUpdates: unitAnalysisSchema.shape.aliasUpdates,
    summary: unitAnalysisSchema.shape.summary, labels: z.record(z.string(), semanticLabelSchema) }).strict().parse(value);
  if (Object.keys(data.labels).length !== units.length || units.some((_, i) => !data.labels[`unit_${i}`])) throw new Error('Missing required source label');
  const raw = restoreUnits({ characters: data.characters, aliasUpdates: data.aliasUpdates, summary: data.summary,
    units: units.map((_, unit) => ({ ...data.labels[`unit_${unit}`]!, unit })) }, units);
  return { ...raw, spans: raw.spans.map(label => {
      // Non-spoken material follows the narrator policy, including epigraphs and quoted titles.
      if (label.kind !== 'dialogue') return { ...label, speaker: 'narrator', certainty: 'attributed' as const };
      if (!/^[“"]/.test(label.text.trimStart()))
        return { ...label, kind: 'prose' as const, speaker: 'narrator', certainty: 'attributed' as const,
          reason: 'Narrator reads the source fragment outside quotation marks.' };
      if (label.speaker === 'anonymous' && label.certainty === 'attributed')
        return { ...label, certainty: 'uncertain' as const, confidence: Math.min(label.confidence, 0.69) };
      return label;
    }) };
}

/** Exact UTF-16 coordinates let the model select boundaries instead of counting. */
export function semanticBoundaryEnds(text: string): number[] {
  const ends: number[] = [];
  for (let end = 1; end <= text.length; end++) {
    const quote = /[“”"‘’']/.test(text[end - 1]!);
    const apostrophe = /[\p{L}\p{N}]/u.test(text[end - 2] ?? '') && /[\p{L}\p{N}]/u.test(text[end] ?? '');
    if (end === text.length || /\s/.test(text[end]!) || /[\s.!?;:]/.test(text[end - 1]!) || (quote && !apostrophe)) ends.push(end);
  }
  return ends;
}
