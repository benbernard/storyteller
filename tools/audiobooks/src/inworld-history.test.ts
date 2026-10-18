import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, sha } from './store.js';
import { seedHistoricalCast } from './inworld-history.js';

test('earlier voiced speakers survive a missing source roster without inventing or leaking future identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inworld-history-')), prior = new Store(join(root, 'prior')), state = new Store(join(root, 'state'));
  try {
    const text = '“Welcome,” said the proprietor.', source = { schemaVersion: 1, fictionId: 'book-1', chapterId: 'chapter-1', sequence: 1, title: 'Chapter One', text, contentHash: sha(text), url: 'https://example.org/1', retrievedAt: new Date().toISOString() };
    const candidate = { id: 'proprietor', name: 'The proprietor', aliases: [], portrayal: 'A shopkeeper', importance: 'minor', tags: [], evidence: text, continuityFrom: null };
    const analysis = { source: source.contentHash, characters: [candidate], spans: [{ speaker: candidate.id, start: 0, end: text.length, text }] };
    await prior.write('queue.json', { chapters: [{ sequence: 1, chapterId: 'chapter-1' }] });
    await prior.write('voices.json', { narrator: { voiceId: 'female-narrator' }, proprietor: { voiceId: 'original-proprietor' } });
    await prior.write('chapters/1/source.json', source); await prior.write('chapters/1/analysis.json', analysis);
    await assert.rejects(seedHistoricalCast(prior.path('queue.json'), state.root, 1), /future/);
    await seedHistoricalCast(prior.path('queue.json'), state.root, 2);
    const roster = await state.read<{ members: { id: string; first: { chapter: number } }[] }>('cast.json');
    assert.equal(roster?.members[0]?.id, candidate.id); assert.equal(roster?.members[0]?.first.chapter, 1);
    await seedHistoricalCast(prior.path('queue.json'), state.root, 2); // A resume keeps the same seed.
    assert.equal((await state.read<{ members: unknown[] }>('cast.json'))?.members.length, 1);
    await prior.write('voices.json', { unknown: { voiceId: 'missing-evidence' } });
    await assert.rejects(seedHistoricalCast(prior.path('queue.json'), state.root, 2), /changed/);
    const badState = new Store(join(root, 'bad-state'));
    await assert.rejects(seedHistoricalCast(prior.path('queue.json'), badState.root, 2), /lack historical/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
