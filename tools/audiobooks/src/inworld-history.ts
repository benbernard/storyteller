/** Restore saved voice identities from verified earlier chapter evidence. */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { Store, fingerprint, sha } from './store.js';
import { chapterSchema, candidateSchema, id, type Analysis, type Cast } from './schema.js';
const read = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8')) as unknown;
export async function seedHistoricalCast(priorQueue: string, state: string, firstSequence: number): Promise<void> {
  const prior = z.object({ chapters: z.array(z.object({ sequence: z.number().int().positive(), chapterId: id })) }).parse(await read(priorQueue));
  if (prior.chapters.some(c => c.sequence >= firstSequence)) throw Error('Historical voices cannot introduce future chapter knowledge');
  const root = dirname(priorQueue), voices = z.record(id, z.object({ voiceId: z.string().min(1) }).passthrough()).parse(await read(join(root, 'voices.json')));
  const store = new Store(state), dependency = fingerprint({ prior: prior.chapters, voices, firstSequence });
  await store.lock(async () => {
    const saved = await store.read<{ dependency: string }>('inworld-history-seed.json');
    if (saved) { if (saved.dependency !== dependency) throw Error('Historical voice seed changed'); return; }
    const roster = await store.read<Cast>('cast.json') ?? { schemaVersion: 1, members: [] };
    const audit = await store.read<{ bookId: string; audioRegenerationAuthorized: boolean; decisions: { id: string; canonicalId: string; portrayal: string }[] }>('casting-review.json');
    for (const entry of prior.chapters) {
      const path = join(root, 'chapters', String(entry.sequence));
      const source = chapterSchema.parse(await read(join(path, 'source.json')));
      const analysis = await read(join(path, 'analysis.json')) as Analysis;
      if (source.chapterId !== entry.chapterId || source.sequence !== entry.sequence || sha(source.text) !== source.contentHash || analysis.source !== source.contentHash) throw Error('Historical character evidence belongs to a different source');
      if (audit && audit.bookId !== source.fictionId) throw Error('Historical casting review belongs to another book');
      for (const raw of analysis.characters) {
        const profile = candidateSchema.parse(raw);
        if (roster.members.some(m => m.id === profile.id)) continue;
        const span = analysis.spans.find(s => s.speaker === profile.id);
        if (!span || !source.text.includes(profile.evidence) || source.text.slice(span.start, span.end) !== span.text) throw Error('Historical speaker has no source-grounded appearance');
        roster.members.push({ id: profile.id, name: profile.name, aliases: profile.aliases.map(name => ({ name, from: { chapter: entry.sequence, offset: span.start } })), first: { chapter: entry.sequence, offset: span.start }, evidence: profile.evidence, portrayal: profile.portrayal, importance: profile.importance, voices: [] });
      }
    }
    const missing = Object.keys(voices).filter(role => !['narrator', 'author-note', 'anonymous'].includes(role) && !roster.members.some(m => m.id === role));
    if (missing.length) throw Error('Saved voices lack historical identities: ' + missing.join(', '));
    if (audit?.audioRegenerationAuthorized) for (const decision of audit.decisions) {
      const member = roster.members.find(m => m.id === decision.id);
      if (member && decision.id === decision.canonicalId) member.portrayal = decision.portrayal;
    }
    await store.object('cast-history', roster); await store.write('cast.json', roster);
    await store.write('inworld-history-seed.json', { dependency, source: priorQueue, firstSequence, roles: Object.keys(voices), members: roster.members.length });
  });
}
