import { parseArgs } from 'node:util';
import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { frontierPolicySchema } from './frontier-analysis.js';
import { LibraryQueue } from './library-queue.js';
import { type Book } from './book.js';
import { Store, sha } from './store.js';
import { assignLocal, saveLocalCast, poolSchema, type LocalCast, type LocalVoice } from './local-cast.js';
import { type Cast, type Chapter } from './schema.js';
import { type SourceIndex } from './local-ingest.js';
type ImportedCast = { model: string; revision: string; voices: Record<string, { reference_id: string; sha256: string; transcript: string; provenance: string }> };
export async function importReferences(cast: ImportedCast, directory: string, destination: Store, tags: Record<string, { tags: string[]; reserved?: boolean }>) {
  const voices: Record<string, LocalVoice> = {};
  for (const [role, voice] of Object.entries(cast.voices)) {
    if (!/^[A-Za-z0-9_-]+$/.test(role) || !tags[role]) throw new Error(`Missing explicit reference tags for ${role}`);
    const source = join(directory, role, 'reference.wav'); if (sha(await readFile(source)) !== voice.sha256) throw new Error(`Reference checksum mismatch for ${role}`);
    const folder = destination.path('local-references'); await mkdir(folder, { recursive: true, mode: 0o700 });
    await copyFile(source, join(folder, `${voice.sha256}.wav`));
    await destination.object('reference-provenance', { role, ...voice });
    voices[role] = { reference_id: voice.reference_id, sha256: voice.sha256, transcript: voice.transcript, provenance: voice.provenance, tags: tags[role]!.tags, reserved: tags[role]!.reserved ?? false };
  }
  return voices;
}
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { state: { type: 'string' }, cast: { type: 'string' }, references: { type: 'string' }, tags: { type: 'string' }, pool: { type: 'string' }, role: { type: 'string' }, reference: { type: 'string' }, chapter: { type: 'string' }, offset: { type: 'string', default: '0' }, reason: { type: 'string' }, correction: { type: 'boolean', default: false }, listener: { type: 'string' }, owner: { type: 'string' }, chapters: { type: 'string' }, policy: { type: 'string' } } });
  const required = (name: keyof typeof values) => { const value = values[name]; if (typeof value !== 'string' || !value) throw new Error(`--${name} is required`); return value; };
  const state = new Store(resolve(required('state')));
  if (positionals[0] === 'pool' || positionals[0] === 'seed-story') {
    const cast = JSON.parse(await readFile(required('cast'), 'utf8')) as ImportedCast;
    if (cast.model !== 'qwen-base') throw new Error('Production local speech uses Qwen');
    const tags = JSON.parse(await readFile(required('tags'), 'utf8')) as Record<string, { tags: string[]; reserved?: boolean }>;
    const voices = await importReferences(cast, required('references'), state, tags);
    if (positionals[0] === 'pool') {
      const pool = poolSchema.parse({ schemaVersion: 1, model: cast.model, revision: cast.revision, narrator: voices.narrator, anonymous: voices.anonymous, voices: Object.entries(voices).filter(([role]) => !['narrator', 'anonymous'].includes(role)).map(([, voice]) => voice) });
      await state.object('pool-history', pool); await state.write('pool.json', pool); console.log(JSON.stringify({ references: Object.keys(voices).length })); return;
    }
    if (await state.read('local-cast.json')) throw new Error('Story already has a local cast; use an explicit recast');
    const roster = await state.read<Cast>('cast.json'); const index = (await state.read<SourceIndex>('index.json'))!;
    let local: LocalCast = { schemaVersion: 1, model: 'qwen-base', revision: cast.revision, assignments: [] };
    for (const [role, voice] of Object.entries(voices)) {
      const member = roster?.members.find(m => m.id === role); if (!member && role !== 'narrator') throw new Error(`Original casting metadata is missing for ${role}`);
      const from = member?.first ?? { chapter: 1, offset: 0 }; const entry = index.chapters.find(c => c.sequence === from.chapter); if (!entry) throw new Error('Original source chapter is missing');
      const chapter = (await state.read<Chapter>(`sources/${entry.current}.json`))!;
      local = assignLocal(local, role, voice, from, chapter.contentHash, member?.evidence || chapter.text.slice(0, 200), 'Preserve the selected five-chapter Qwen sample cast');
    }
    const revision = await saveLocalCast(state, local); await state.object('local-cast-imports', cast); console.log(JSON.stringify({ roles: local.assignments.length, revision })); return;
  }
  if (positionals[0] === 'analysis-policy') return state.lock(async () => {
    const policy = frontierPolicySchema.parse(JSON.parse(await readFile(required('policy'), 'utf8')));
    await state.object('frontier-policy-history', policy); await state.write('frontier-policy.json', policy); console.log(JSON.stringify(policy));
  });
  if (positionals[0] === 'repair') {
    return state.lock(async () => {
      const book = await state.read<Book>('book.json'); if (!book) throw new Error('Book is missing');
      const ids = required('chapters').split(','); const chapters = book.editions.qwen?.chapters.filter(c => ids.includes(c.id)) ?? [];
      if (chapters.length !== ids.length) throw new Error('Choose distinct published Qwen chapters');
      const queue = new LibraryQueue(required('listener'));
      try { console.log(JSON.stringify(queue.repair(required('owner'), book.id, Object.fromEntries(chapters.map(c => [c.id, c.assembly])), required('reason')))); }
      finally { queue.close(); }
    });
  }
  if (positionals[0] === 'recast') {
    return state.lock(async () => {
    const cast = await state.read<LocalCast>('local-cast.json'); if (!cast) throw new Error('Local cast is missing');
    const pool = poolSchema.parse(JSON.parse(await readFile(required('pool'), 'utf8')));
    const voice = [pool.narrator, pool.anonymous, ...pool.voices].find(v => v.sha256 === required('reference')); if (!voice) throw new Error('Reference is not in the verified pool');
    const at = { chapter: Number(required('chapter')), offset: Number(required('offset')) };
    if (!Number.isSafeInteger(at.chapter) || at.chapter < 1 || !Number.isSafeInteger(at.offset) || at.offset < 0) throw new Error('Invalid effective source position');
    const index = (await state.read<SourceIndex>('index.json'))!, entry = index.chapters.find(c => c.sequence === at.chapter); if (!entry) throw new Error('Source chapter is missing');
    const chapter = (await state.read<Chapter>(`sources/${entry.current}.json`))!; const evidence = chapter.text.slice(at.offset, at.offset + 200);
    const revision = await saveLocalCast(state, assignLocal(cast, required('role'), voice, at, chapter.contentHash, evidence, required('reason'), values.correction));
    console.log(JSON.stringify({ revision, nextStep: 'Create and review a new repair batch; published audio remains addressable.' }));
    });
  }
  throw new Error('Use pool, seed-story, recast, analysis-policy or repair with --state and the documented input files');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
