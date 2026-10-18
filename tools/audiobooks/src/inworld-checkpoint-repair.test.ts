import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, sha, fingerprint } from './store.js';
import { type Cast, type Chapter } from './schema.js';
import type { FrontierResult } from './frontier-analysis.js';
import { repairConcealedCheckpoint } from './inworld-checkpoint-repair.js';

test('concealed compatibility repair preserves complete evidence and paid inputs and refuses queued checkpoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inworld-checkpoint-')), job = new Store(root), state = new Store(join(root, 'state')), plans = new Store(join(root, 'preparation'));
  try {
    const text = '“Approach.”', chapterId = 'chapter-2';
    const chapter: Chapter = { schemaVersion: 1, fictionId: 'book', chapterId, sequence: 2, title: 'Chapter Two', url: 'https://example.org/2', retrievedAt: new Date().toISOString(), text, contentHash: sha(text) };
    const attribution: FrontierResult = { profiles: [], analysis: { schemaVersion: 1, source: chapter.contentHash, fingerprint: 'progenitor', promptVersion: 'test', model: 'fixture', characters: [], aliasUpdates: [], summary: 'Identity remains hidden.', spans: [
      { uid: 'span-hidden', start: 0, end: text.length, text, kind: 'dialogue', speaker: 'concealed:warren_throne_occupant', certainty: 'concealed', confidence: 1, reason: 'Source conceals the speaker' },
    ] } };
    await state.write('index.json', { chapters: [{ id: chapterId, current: chapter.contentHash }] });
    await state.write(`sources/${chapter.contentHash}.json`, chapter);
    await state.write('cast.json', { schemaVersion: 1, members: [] });
    await job.write('planner.json', { state: state.root, directory: plans.root });
    await job.write('config.json', { root, plannerConfig: job.path('planner.json'), chapterIds: [chapterId] });
    const plan = new Store(plans.path('plans', chapterId));
    await plan.write('dependencies.json', { source: chapter.contentHash }); await plan.write('attribution.json', attribution);
    const paidQueue = { chapters: [{ chapterId: 'chapter-1', inputHash: 'unchanged' }] }, reservations = { charges: [{ status: 'pending', reservedUSD: 1 }] };
    await job.write('queue.json', paidQueue); await job.write('reservations.json', reservations);
    const invoke = () => repairConcealedCheckpoint(job.path('config.json'), chapterId, chapter.contentHash, fingerprint(attribution));
    await assert.rejects(repairConcealedCheckpoint(job.path('config.json'), chapterId, 'wrong-source', fingerprint(attribution)), /source checksum/);
    await assert.rejects(repairConcealedCheckpoint(job.path('config.json'), chapterId, chapter.contentHash, 'wrong-attribution'), /attribution fingerprint/);
    await job.write('queue.json', { chapters: [...paidQueue.chapters, { chapterId, inputHash: 'queued' }] });
    await assert.rejects(invoke(), /queued or materialized/); await job.write('queue.json', paidQueue);
    await plan.write('directions-0.json', {}); await assert.rejects(invoke(), /acting directions/); await rm(plan.path('directions-0.json'));
    const repaired = await invoke(), corrected = (await plan.read<FrontierResult>('attribution.json'))!;
    assert.equal(repaired.repaired, 1);
    assert.deepEqual(corrected.analysis.spans, [{ ...attribution.analysis.spans[0]!, speaker: 'anonymous' }]);
    assert.notEqual(corrected.analysis.fingerprint, attribution.analysis.fingerprint);
    const backup = new Store(repaired.receipt.substring(0, repaired.receipt.lastIndexOf('/')));
    assert.deepEqual(await backup.read('attribution.original.json'), attribution);
    assert.equal((await state.read<Cast>('cast.json'))!.members[0]!.id, 'concealed:warren_throne_occupant');
    assert.equal((await state.read<Cast>('cast.json'))!.members[0]!.first.chapter, 2);
    assert.deepEqual(await job.read('queue.json'), paidQueue); assert.deepEqual(await job.read('reservations.json'), reservations);
    assert.deepEqual(await invoke(), repaired);
  } finally { await rm(root, { recursive: true, force: true }); }
});
