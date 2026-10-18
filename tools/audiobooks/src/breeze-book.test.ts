import test from 'node:test';
import assert from 'node:assert/strict';
import { bindVoices } from './breeze-book.js';
import { type Analysis } from './schema.js';
const voice = (id: string) => ({ reference_id: id, sha256: 'a'.repeat(64), transcript: 'A synthetic reference.',
  provenance: 'Original synthetic voice', tags: ['female'], reserved: false });
const catalog = { revision: 'b'.repeat(40), voices: {
  narrator: { voice: voice('n'), identities: ['narrator'], description: 'Narrator', path: '/n.wav' },
  child: { voice: voice('c'), identities: ['mara'], description: 'Child Mara', path: '/c.wav' },
  teen: { voice: voice('t'), identities: ['mara'], description: 'Adolescent Mara', path: '/t.wav' },
  luma: { voice: voice('s'), identities: ['luma'], description: 'Luma', path: '/s.wav' },
} };
const analysis: Analysis = { schemaVersion: 1, source: 'a'.repeat(64), fingerprint: 'b'.repeat(64), model: 'gpt-6.1-sol',
  promptVersion: 'test', characters: [], aliasUpdates: [], summary: 'Mara changes body.', spans: [
    { uid: 'one', start: 0, end: 5, text: 'Hello', speaker: 'mara', kind: 'dialogue', certainty: 'attributed', confidence: 1, reason: 'Mara speaks' },
    { uid: 'two', start: 5, end: 12, text: ' Shift.', speaker: 'narrator', kind: 'prose', certainty: 'attributed', confidence: 1, reason: 'Narration' },
    { uid: 'three', start: 12, end: 16, text: 'Now.', speaker: 'mara', kind: 'dialogue', certainty: 'attributed', confidence: 1, reason: 'Mara speaks' },
  ] };
const choice = { speaker: 'mara', voiceKey: 'child', reason: 'The source establishes the child body.', changes: [
  { fromSpanUid: 'three', voiceKey: 'teen', reason: 'An explicit transformation precedes this speech.' },
] };
test('a body-stage change uses its exact first spoken span and preserves all source offsets', () => {
  const bound = bindVoices(analysis, { choices: [choice] }, catalog, new Map([['mara', 'mara']]));
  assert.deepEqual(bound.analysis.spans.map(s => s.speaker), ['mara__child', 'narrator', 'mara__teen']);
  assert.deepEqual(bound.analysis.spans.map(({ speaker: _speaker, ...s }) => s), analysis.spans.map(({ speaker: _speaker, ...s }) => s));
  assert.equal(bound.voices.mara__child?.reference_id, 'c');
  assert.equal(bound.voices.mara__teen?.reference_id, 't');
  assert.equal(analysis.spans[0]!.speaker, 'mara');
});
test('casting refuses another identity, skipped speakers and changes in narrator spans', () => {
  const ids = new Map([['mara', 'mara']]);
  assert.throws(() => bindVoices(analysis, { choices: [] }, catalog, ids), /every ordered speaker/);
  assert.throws(() => bindVoices(analysis, { choices: [{ ...choice, voiceKey: 'luma' }] }, catalog, ids), /not reviewed/);
  assert.throws(() => bindVoices(analysis, { choices: [{ ...choice, changes: [{ ...choice.changes[0]!, fromSpanUid: 'two' }] }] }, catalog, ids), /exact ordered speech/);
  assert.throws(() => bindVoices(analysis, { choices: [{ ...choice, changes: [{ ...choice.changes[0]!, fromSpanUid: 'one' }] }] }, catalog, ids), /exact ordered speech/);
});
test('a new speaker needs matching source-grounded age and gender for a wildcard voice', () => {
  const source: Analysis = { ...analysis, characters: [{ id: 'mara', name: 'A new woman', aliases: [],
    portrayal: 'An adult woman.', importance: 'minor', tags: ['female', 'adult'], evidence: 'Hello', continuityFrom: null }] };
  const choices = { choices: [{ ...choice, voiceKey: 'generic', changes: [] }] };
  const generic = { ...catalog, voices: { ...catalog.voices,
    generic: { ...catalog.voices.child, identities: ['*'], voice: { ...voice('g'), tags: ['female', 'child'] } } } };
  assert.throws(() => bindVoices(source, choices, generic, new Map()), /source-grounded gender and age/);
  source.characters[0]!.tags = ['female', 'child'];
  assert.equal(bindVoices(source, choices, generic, new Map()).voices.mara__generic?.reference_id, 'g');
  source.characters[0]!.tags = ['child'];
  assert.throws(() => bindVoices(source, choices, generic, new Map()), /source-grounded gender and age/);
});

test('returning speakers retain their final stage and retries use the incoming snapshot', async () => {
  const { continueVoices } = await import('./breeze-book.js');
  const incoming = { mara: 'child', luma: 'luma' };
  const final = continueVoices(incoming, { choices: [choice] });
  assert.deepEqual(final, { mara: 'teen', luma: 'luma' });
  assert.deepEqual(incoming, { mara: 'child', luma: 'luma' });
  assert.deepEqual(continueVoices(incoming, { choices: [choice] }), final);
  assert.throws(() => continueVoices(final, { choices: [choice] }), /Established voice changed/);
  assert.equal(continueVoices(final, { choices: [{ ...choice, voiceKey: 'teen', changes: [] }] }).mara, 'teen');
});

test('resumed Breeze preparation pins source and presentation before reusing directions', async () => {
  const { BookWorker, bookConfigSchema } = await import('./breeze-book.js');
  const { Store, sha } = await import('./store.js');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(join(tmpdir(), 'breeze-prepare-'));
  try {
    const state = new Store(join(directory, 'state')), root = join(directory, 'job/trials/chapter-1'); await mkdir(root, { recursive: true });
    const text = 'The lantern burned.', chapter = { schemaVersion: 1 as const, fictionId: 'lantern', chapterId: 'chapter-1', sequence: 1,
      url: 'https://example.org/lantern', title: 'One', text, contentHash: sha(text), retrievedAt: '2026-10-17T00:00:00Z' };
    const source = await state.object('sources', chapter);
    await state.write('index.json', { fictionId: 'lantern', chapters: [{ id: chapter.chapterId, current: source }] });
    await state.write('casting-review.json', { bookId: 'lantern', audioRegenerationAuthorized: true, decisions: [] });
    const sourceAnalysis: Analysis = { ...analysis, source: chapter.contentHash, characters: [], spans: [{ ...analysis.spans[1]!, start: 0, end: text.length, text }], summary: 'A lantern burns.' };
    await writeFile(join(root, 'source-analysis.json'), JSON.stringify({ analysis: sourceAnalysis, profiles: [] }));
    await writeFile(join(root, 'voice-bindings.json'), JSON.stringify({ value: { choices: [] } }));
    await writeFile(join(root, 'directions.json'), '{}');
    const model = join(directory, 'model.json'), presentation = join(directory, 'presentation.json');
    await writeFile(model, '{}'); await writeFile(presentation, '{}');
    const config = bookConfigSchema.parse({ queue: { fiction: 'lantern', edition: 'breeze', directory: join(directory, 'job'), state: state.root,
      tooling: directory, credential: join(directory, 'credential'), python: '/python', asrPython: '/asr', phonemePython: '/phoneme', source: 'a'.repeat(40),
      title: 'Lantern', analysisModel: 'fixture', listenerUrl: 'http://localhost:8080', listenerUsername: 'listener', listenerPasswordFile: '/password',
      ownerInstruction: 'Generate this reviewed synthetic chapter.' }, chapterIds: [chapter.chapterId], catalog: '/catalog', model, presentation });
    const worker = new BookWorker(config);
    worker.command = async () => { throw new Error('A resume must not start a model'); };
    assert.equal((await worker.prepare(chapter.chapterId, 'prior context', catalog)).summary, sourceAnalysis.summary);
    assert.equal((await worker.prepare(chapter.chapterId, 'prior context', catalog)).summary, sourceAnalysis.summary);
    await assert.rejects(worker.prepare(chapter.chapterId, 'changed context', catalog));
    await writeFile(presentation, '{"title":"changed"}');
    await assert.rejects(worker.prepare(chapter.chapterId, 'prior context', catalog));
    await writeFile(presentation, '{}');
    const replacement = { ...chapter, text: 'A different source.', contentHash: sha('A different source.') };
    const next = await state.object('sources', replacement);
    await state.write('index.json', { fictionId: 'lantern', chapters: [{ id: chapter.chapterId, current: next }] });
    await assert.rejects(worker.prepare(chapter.chapterId, 'prior context', catalog));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a fiction lock rejects another active job and releases for the next worker', async () => {
  const { acquireBookLock } = await import('./breeze-book.js');
  const { mkdtemp, rm } = await import('node:fs/promises'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'breeze-lock-'));
  try {
    const lock = join(root, 'state/lock'), release = await acquireBookLock(lock);
    await assert.rejects(acquireBookLock(lock), /Another book worker/);
    await release(); const releaseNext = await acquireBookLock(lock); await releaseNext();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('voice keys keep the same reference checksum across chapter jobs', async () => {
  const { pinVoiceReferences } = await import('./breeze-book.js');
  const pinned = pinVoiceReferences({}, catalog);
  assert.equal(pinned.narrator, catalog.voices.narrator.voice.sha256);
  assert.deepEqual(pinVoiceReferences(pinned, catalog), pinned);
  const changed = structuredClone(catalog); changed.voices.narrator.voice.sha256 = 'f'.repeat(64);
  assert.throws(() => pinVoiceReferences(pinned, changed), /Voice reference changed/);
});
