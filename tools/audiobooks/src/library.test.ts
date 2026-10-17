import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LibraryQueue, royalRoadUrl, type LibraryJob } from './library-queue.js';
import { assignLocal, extendLocalCast, localVoiceAt, renderCast, type LocalPool, type LocalCast } from './local-cast.js';
import { restoreRanges } from './local-analysis.js';
import { desiredChapters } from './library-worker.js';
import { type SourceIndex } from './local-ingest.js';
import { type Analysis, type Chapter } from './schema.js';
const voice = (n: string, tags: string[]) => ({ reference_id: randomUUID(), sha256: n.repeat(64), transcript: 'A fixed reference.', provenance: 'Synthetic audition fixture', tags, reserved: false });
const narrator = voice('a', ['narrator']), anonymous = voice('b', ['neutral']), woman = voice('c', ['adult', 'female']), man = voice('d', ['adult', 'male']);
const pool: LocalPool = { schemaVersion: 1, model: 'qwen-base', revision: 'a'.repeat(40), narrator, anonymous, voices: [woman, man] };
const cast: LocalCast = { schemaVersion: 1, model: 'qwen-base', revision: pool.revision, assignments: [] };
const chapter: Chapter = { schemaVersion: 1, fictionId: 'rr-1', chapterId: 'c1', sequence: 1, title: 'One', url: 'https://www.royalroad.com/fiction/1', retrievedAt: new Date().toISOString(), text: '“Hello,” Alice said.', contentHash: 'e'.repeat(64) };
const analysis: Analysis = { schemaVersion: 1, source: chapter.contentHash, fingerprint: 'x', model: 'fixture', promptVersion: 'fixture', summary: '', aliasUpdates: [], characters: [{ id: 'alice', name: 'Alice', aliases: [], portrayal: 'Adult woman', importance: 'major', tags: ['adult', 'female'], evidence: chapter.text, continuityFrom: null }], spans: [{ uid: 'span1', start: 0, end: 8, text: '“Hello,”', kind: 'dialogue', speaker: 'alice', certainty: 'attributed', confidence: 1, reason: 'Explicit dialogue tag' }, { uid: 'span2', start: 8, end: chapter.text.length, text: ' Alice said.', kind: 'prose', speaker: 'narrator', certainty: 'attributed', confidence: 1, reason: 'Narration' }] };
test('queue survives reopening, isolates owners and cancels without losing an in-flight update', async () => {
  const path = await mkdtemp(join(tmpdir(), 'library-queue-')); let queue = new LibraryQueue(path);
  try {
    const follow = { url: 'https://www.royalroad.com/fiction/12/example', enabled: true, mode: 'buffer' as const, buffer: 5, intervalHours: 6 };
    queue.follow('owner', follow); queue.follow('owner', follow); assert.equal(queue.jobs('owner').length, 1);
    assert.equal(queue.jobs('other').length, 0); const id = queue.jobs('owner')[0]!.id;
    assert.throws(() => queue.action('other', id, 'cancel'), /not_found/);
    assert.equal(queue.lease('worker1'), true); assert.equal(queue.lease('worker2'), false);
    const job = queue.claim('worker1')!; assert.equal(job.status, 'running');
    queue.action('owner', id, 'cancel'); job.phase = 'Still finishing a passage'; queue.update(job); assert.equal(queue.get(id)?.cancel, true);
    queue.close(); queue = new LibraryQueue(path); assert.equal(queue.get(id)?.cancel, true);
    queue.release('worker1'); queue.lease('worker2'); assert.equal(queue.get(id)?.status, 'cancelled');
    queue.action('owner', id, 'retry'); assert.equal(queue.claim('worker2')?.id, id);
  } finally { queue.close(); await rm(path, { recursive: true, force: true }); }
});
test('only canonical Royal Road fiction URLs can schedule downloads', () => {
  assert.equal(royalRoadUrl('https://www.royalroad.com/fiction/123/a-story').story, 'rr-123');
  for (const value of ['http://www.royalroad.com/fiction/1', 'https://www.royalroad.com.evil.test/fiction/1', 'https://owner@www.royalroad.com/fiction/1', 'https://www.royalroad.com/fiction/1/chapter/2']) assert.throws(() => royalRoadUrl(value));
});
test('switching a running text download to audio schedules generation after cancellation', async () => {
  const path = await mkdtemp(join(tmpdir(), 'library-mode-')); const queue = new LibraryQueue(path);
  try {
    const input = { url: 'https://www.royalroad.com/fiction/12', enabled: true, mode: 'download' as const, buffer: 5, intervalHours: 6 };
    queue.follow('owner', input); queue.lease('worker'); const job = queue.claim('worker')!;
    queue.follow('owner', { ...input, mode: 'all' }); assert.equal(queue.get(job.id)?.cancel, true);
    queue.schedule(); job.status = 'cancelled'; queue.update(job); queue.schedule();
    const next = queue.claim('worker')!; assert.notEqual(next.id, job.id); assert.equal(next.mode, 'all');
  } finally { queue.close(); await rm(path, { recursive: true, force: true }); }
});
test('local casting keeps recorded voices and requires an explicit later change', () => {
  const extended = extendLocalCast(cast, { schemaVersion: 1, members: [] }, analysis, chapter, pool);
  assert.equal(localVoiceAt(extended.cast, 'alice', { chapter: 1, offset: 0 }).sha256, woman.sha256);
  const later = extendLocalCast(extended.cast, extended.metadata, { ...analysis, characters: [], spans: analysis.spans }, { ...chapter, sequence: 2 }, { ...pool, voices: [man] });
  assert.equal(localVoiceAt(later.cast, 'alice', { chapter: 2, offset: 0 }).sha256, woman.sha256);
  assert.equal(later.cast.assignments.length, 2); assert.equal(renderCast(later.cast, analysis, chapter).voices.alice?.sha256, woman.sha256);
  assert.throws(() => assignLocal(later.cast, 'alice', man, { chapter: 1, offset: 0 }, chapter.contentHash, 'Evidence', 'Correction'), /later effective/);
  const changed = assignLocal(later.cast, 'alice', man, { chapter: 3, offset: 0 }, chapter.contentHash, 'Evidence', 'Owner requested recast');
  assert.equal(localVoiceAt(changed, 'alice', { chapter: 2, offset: 100 }).sha256, woman.sha256);
  assert.equal(localVoiceAt(changed, 'alice', { chapter: 3, offset: 0 }).sha256, man.sha256);
  assert.equal(changed.assignments.at(-1)?.parent, later.cast.assignments.find(a => a.role === 'alice')?.id);
  assert.throws(() => extendLocalCast(cast, { schemaVersion: 1, members: [] }, analysis, chapter, { ...pool, voices: [man] }), /No compatible/);
});
test('range analysis restores exact text and rejects missing or overlapping units', () => {
  const units = ['A pause.\n', '“Hello.”', ' She smiled.'];
  const prose = { kind: 'prose', speaker: 'narrator', certainty: 'attributed', confidence: 1, reason: 'Narration' };
  const input = { characters: [], aliasUpdates: [], summary: 'A greeting.', ranges: [{ ...prose, first: 0, last: 2 }] };
  assert.equal(restoreRanges(input, units).spans.map(s => s.text).join(''), units.join(''));
  assert.throws(() => restoreRanges({ ...input, ranges: [{ ...prose, first: 1, last: 2 }] }, units), /expected 0/);
  assert.throws(() => restoreRanges({ ...input, ranges: [{ ...prose, first: 0, last: 1 }] }, units), /Uncovered unit 2/);
});
test('buffer follows completion, not an accidental saved position; published source changes stop generation', () => {
  const index: SourceIndex = { schemaVersion: 1, fictionId: 'rr-1', chapters: Array.from({ length: 9 }, (_, i) => ({ id: `c${i + 1}`, sequence: i + 1, current: String(i).repeat(64), revisions: [] })) };
  const job = { story: 'rr-1', mode: 'buffer', buffer: 5 } as LibraryJob;
  assert.deepEqual(desiredChapters(index, undefined, job, {}), ['c1', 'c2', 'c3', 'c4', 'c5']);
  assert.deepEqual(desiredChapters(index, undefined, job, { 'rr-1:c1': true }), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  const book = { schemaVersion: 1 as const, id: 'rr-1', title: '', author: '', defaultEdition: 'qwen' as const, editions: { qwen: { batch: '', publishedAt: '', chapters: [{ id: 'c1', sequence: 1, title: '', assembly: 'a', duration: 1, source: 'changed', checksum: '' }] } } };
  assert.throws(() => desiredChapters(index, book, job, {}), /Published text changed/);
});

test('legacy cast corrections supersede old assignments while preserving historical decisions', () => {
  const original = assignLocal(cast, 'alice', man, { chapter: 1, offset: 10 }, chapter.contentHash, 'Alice spoke.', 'Legacy');
  const fixed = assignLocal(original, 'alice', woman, { chapter: 1, offset: 0 }, chapter.contentHash, 'She spoke.', 'Correct gender and missed first line', true);
  assert.equal(localVoiceAt(fixed, 'alice', { chapter: 1, offset: 20 }).sha256, woman.sha256);
  assert.equal(original.assignments[0]!.voice.sha256, man.sha256);
  assert.equal(fixed.assignments[1]!.correctionOf, original.assignments[0]!.id);
});
test('unknown gender does not silently choose the first gendered reference', () => {
  const unknown = { ...analysis, characters: analysis.characters.map(c => ({ ...c, tags: [] })) };
  assert.throws(() => extendLocalCast(cast, { schemaVersion: 1, members: [] }, unknown, chapter, pool), /needs review/);
});
test('explicit repair jobs pin original assemblies and cannot overlap active story work', async () => {
  const path = await mkdtemp(join(tmpdir(), 'library-repair-')); const queue = new LibraryQueue(path);
  try {
    queue.follow('owner', { url: 'https://www.royalroad.com/fiction/12', enabled: false, mode: 'all', buffer: 5, intervalHours: 6 });
    const job = queue.repair('owner', 'rr-12', { c1: 'old-assembly' }, 'Correct attribution');
    assert.deepEqual(job.chapters, ['c1']); assert.equal(job.repair?.originals.c1, 'old-assembly');
    assert.throws(() => queue.repair('owner', 'rr-12', { c1: 'old' }, 'Again'), /active/);
  } finally { queue.close(); await rm(path, { recursive: true, force: true }); }
});
