import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { LibraryQueue } from './library-queue.js';
import { repairStatus } from './repair-status.js';

test('repair status proves publication and distinguishes active, queued, and blocked chapters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repair-status-'));
  const queue = new LibraryQueue(join(directory, 'queue'));
  try {
    const store = new Store(join(directory, 'story'));
    const job = queue.repair('owner', 'story', { one: 'old', two: 'old', three: 'old' }, 'Fix casting');
    job.status = 'running'; job.currentChapter = 'two'; job.phase = 'Assigning speakers with gpt-6.1-sol in chapter 2';
    const chapters = ['one', 'two', 'three'].map((chapterId, i) => ({ chapterId, title: `Chapter ${i + 1}` }));
    await store.write('book.json', { editions: { qwen: { chapters: [{ id: 'one', assembly: 'new', sequence: 1 }, { id: 'two', assembly: 'other', sequence: 2 }] } } });
    await store.write(`deliveries/auto-${job.id}-1/manifest.json`, { chapters: [{ assembly: 'new' }] });
    let status = await repairStatus(directory, 'story', [job], chapters);
    assert.equal(status?.completed, 1);
    assert.deepEqual(status?.chapters.map(c => c.state), ['published', 'running', 'queued']);
    assert.match(status!.detail, /Chapter 2.*Reanalyzing dialogue/);
    job.status = 'failed'; status = await repairStatus(directory, 'story', [job], chapters);
    assert.equal(status?.chapters[1]?.label, 'Needs review');
    assert.equal(status?.title, 'Audio repair needs review');
    assert.equal(await repairStatus(directory, 'story', queue.jobs('other'), chapters), null);
    job.status = 'queued'; status = await repairStatus(directory, 'story', [job], chapters);
    assert.equal(status?.chapters[1]?.state, 'queued');
    job.status = 'cancelled'; status = await repairStatus(directory, 'story', [job], chapters);
    assert.equal(status?.title, 'Audio repair cancelled');
    assert.equal(status?.chapters[0]?.state, 'published');
    assert.equal(status?.chapters[1]?.label, 'Repair cancelled');
    job.chapters = ['one']; job.status = 'complete'; status = await repairStatus(directory, 'story', [job], chapters);
    assert.equal(status?.title, 'Audio repair complete');
  } finally { queue.close(); await rm(directory, { recursive: true, force: true }); }
});

test('review-only plans never claim audio has been queued', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repair-plan-'));
  try {
    await new Store(join(directory, 'story')).write('casting-review.json', { status: 'reviewed-plan-not-rendered', audioRegenerationAuthorized: false, decisions: [{ evidence: 'private story text' }] });
    const status = await repairStatus(directory, 'story', [], []);
    assert.equal(status?.status, 'reviewed');
    assert.equal(status?.total, 0);
    assert.match(status!.detail, /not queued/);
    assert.equal(JSON.stringify(status).includes('private story'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
