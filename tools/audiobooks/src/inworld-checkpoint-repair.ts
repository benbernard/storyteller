/** One bounded compatibility repair for an unqueued concealed-speaker checkpoint. */
import { readFile, access, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Store, fingerprint, sha } from './store.js';
import { chapterSchema, type Cast, type Analysis } from './schema.js';
import { validateAnalysis } from './analysis.js';
import { historicalCast, registerConcealedMarkers } from './inworld-registry.js';
import type { FrontierResult } from './frontier-analysis.js';

const policy = 'inworld-concealed-anonymous-compatibility-v1';
const read = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8')) as unknown;
const exists = async (path: string): Promise<boolean> => { try { await access(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } };
function validate(analysis: Analysis, chapter: z.infer<typeof chapterSchema>, cast: Cast): Analysis {
  const raw = { characters: analysis.characters, aliasUpdates: analysis.aliasUpdates, summary: analysis.summary,
    spans: analysis.spans.map(({ uid: _uid, start: _start, end: _end, ...span }) => span) };
  const known = { ...cast, members: cast.members.filter(member => !analysis.characters.some(candidate => candidate.id === member.id)) };
  const spans = validateAnalysis(raw, chapter, known, analysis);
  if (spans.some((span, i) => span.uid !== analysis.spans[i]!.uid || span.start !== analysis.spans[i]!.start || span.end !== analysis.spans[i]!.end)) throw Error('Repair changed source positions or span identities');
  return { ...analysis, spans };
}
export async function repairConcealedCheckpoint(configPath: string, chapterId: string, expectedSource: string, expectedAttribution: string): Promise<{ repaired: number; receipt: string }> {
  const config = z.object({ root: z.string(), plannerConfig: z.string(), chapterIds: z.array(z.string()) }).parse(await read(configPath));
  if (!config.chapterIds.includes(chapterId)) throw Error('Chapter is outside the selected job scope');
  const planner = z.object({ state: z.string(), directory: z.string() }).parse(await read(config.plannerConfig));
  const state = new Store(planner.state), root = new Store(join(planner.directory, 'plans', chapterId));
  return root.lock(async () => {
    const input = await root.read<{ source: string }>('dependencies.json');
    const index = await state.read<{ chapters: { id: string; current: string }[] }>('index.json');
    const entry = index?.chapters.find(chapter => chapter.id === chapterId);
    if (!entry || input?.source !== entry.current) throw Error('Checkpoint source dependency changed');
    const chapter = chapterSchema.parse(await state.read(`sources/${entry.current}.json`));
    if (chapter.chapterId !== chapterId || chapter.contentHash !== expectedSource || sha(chapter.text) !== expectedSource) throw Error('Expected source checksum does not match');
    const guard = async (): Promise<void> => {
      const queue = await new Store(config.root).read<{ chapters: { chapterId: string }[] }>('queue.json');
      if (queue?.chapters.some(entry => entry.chapterId === chapterId) || await exists(join(config.root, 'chapters', String(chapter.sequence))) || await exists(root.path('plan.json'))) throw Error('Refusing to repair a queued or materialized chapter');
      const names = await readdir(root.root);
      if (names.some(name => /^directions(?:-|\.)/.test(name))) throw Error('Refusing to repair a checkpoint with acting directions');
    };
    await guard();
    const original = await root.read<FrontierResult>('attribution.json');
    const backup = `repairs/${policy}-${expectedAttribution}`;
    if (!original || fingerprint(original) !== expectedAttribution) {
      const saved = await root.read<{ progenitor: string; corrected: string; changes: unknown[] }>(`${backup}/receipt.json`);
      if (original && saved?.progenitor === expectedAttribution && saved.corrected === fingerprint(original)) return { repaired: saved.changes.length, receipt: root.path(`${backup}/receipt.json`) };
      throw Error('Expected attribution fingerprint does not match');
    }
    const cast = historicalCast(await state.read<Cast>('cast.json') ?? { schemaVersion: 1, members: [] }, chapter.sequence);
    validate(original.analysis, chapter, cast);
    const changes = original.analysis.spans.filter(span => span.kind === 'dialogue' && span.certainty === 'concealed' && span.speaker.startsWith('concealed:'));
    if (!changes.length) throw Error('No concealed identity markers require compatibility repair');
    const corrected: FrontierResult = structuredClone(original);
    corrected.analysis.spans = corrected.analysis.spans.map(span => span.kind === 'dialogue' && span.certainty === 'concealed' && span.speaker.startsWith('concealed:') ? { ...span, speaker: 'anonymous' } : span);
    corrected.analysis.fingerprint = fingerprint({ progenitor: original.analysis.fingerprint, checkpoint: expectedAttribution, policy });
    corrected.analysis = validate(corrected.analysis, chapter, cast);
    await root.write(`${backup}/attribution.original.json`, original);
    const receipt = { schemaVersion: 1, policy, chapterId, source: expectedSource, progenitor: expectedAttribution, corrected: fingerprint(corrected),
      changes: changes.map(span => ({ uid: span.uid, start: span.start, end: span.end, originalSpeaker: span.speaker, speaker: 'anonymous', certainty: 'concealed' })) };
    await root.write(`${backup}/receipt.json`, receipt);
    await registerConcealedMarkers(state, chapter, original.analysis);
    // Repeat the boundary checks immediately before replacing the checkpoint.
    await guard();
    if (fingerprint(await root.read('attribution.json')) !== expectedAttribution) throw Error('Attribution changed during repair');
    await root.write('attribution.json', corrected);
    return { repaired: changes.length, receipt: root.path(`${backup}/receipt.json`) };
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [config, chapter, source, attribution] = process.argv.slice(2);
  if (!config || !chapter || !source || !attribution) throw Error('Usage: inworld-checkpoint-repair JOB_CONFIG CHAPTER_ID EXPECTED_SOURCE EXPECTED_ATTRIBUTION');
  console.log(JSON.stringify(await repairConcealedCheckpoint(config, chapter, source, attribution)));
}
