import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateDecisions, qualityStatus, pendingReviews, currentIssues, queueSchema, prepareRetake, finishInterruptedRetakes, ensureFastInference, validateLocalSource } from './breeze-queue.js';
const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
test('missing inference settings select fast generation; explicit slow settings cannot silently run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'breeze-speed-test-'));
  try {
    await ensureFastInference(root);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'inference.json'), 'utf8')),
      { engine: 'cached-depth-v1', bits: 8, groupSize: 64, compiled: true });
    await ensureFastInference(root);
    await writeFile(join(root, 'inference.json'), JSON.stringify({ engine: 'stock-bf16' }));
    await assert.rejects(ensureFastInference(root), /refusing slow fallback/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('validator must cover exact indices; minority issues are provisional and major issues block publication', () => {
  assert.throws(() => validateDecisions({ decisions: [] }, ['0001']), /ordered/);
  assert.throws(() => validateDecisions({ decisions: [{ index: '0002', severity: 'pass', reason: 'Complete words retained.' }] }, ['0001']), /ordered/);
  assert.throws(() => validateDecisions({ decisions: [{ index: '0001', severity: 'ignore', reason: 'Silently skip this issue.' }] }, ['0001']));
  assert.equal(qualityStatus([{ severity: 'pass' }]), 'reviewed');
  assert.equal(qualityStatus([{ severity: 'minor' }]), 'provisional');
  assert.equal(qualityStatus([{ severity: 'minor' }, { severity: 'major' }]), 'blocked');
  assert.equal(qualityStatus([{ severity: 'uncertain' }]), 'blocked');
});
test('retakes preserve original recordings, resume interrupted preparation, and stop at their durable limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'breeze-retake-test-'));
  try {
    await mkdir(join(root, 'segments')); await mkdir(join(root, 'review'));
    const wav = join(root, 'segments/0000.wav'), receiptPath = join(root, 'segments/0000.json');
    let seed = 17;
    const materialize = async (): Promise<void> => {
      const audio = Buffer.from('recording at seed ' + seed);
      await writeFile(wav, audio);
      await writeFile(receiptPath, JSON.stringify({ uid: 'uid1', text: 'A complete sentence.', sha256: sha(audio), model: 'breeze-tts-2', seed }));
      await writeFile(join(root, 'review/0000.json'), '{}');
    };
    await materialize();
    await writeFile(join(root, 'retakes.json'), JSON.stringify({ '0000': { uid: 'uid1', seed: seed + 7919,
      reason: 'Missing sentence.', queueAttempts: 1 } })); // Simulated crash after checkpoint, before cache removal.
    await finishInterruptedRetakes(root);
    await assert.rejects(access(receiptPath)); await assert.rejects(access(wav));
    const attempts = await readdir(join(root, 'attempts'));
    assert.equal(await readFile(join(root, 'attempts', attempts[0]!, 'segments-0000.wav'), 'utf8'), 'recording at seed 17');
    seed += 7919; await materialize();
    await finishInterruptedRetakes(root); assert.equal(await readFile(wav, 'utf8'), 'recording at seed ' + seed);
    for (let attempt = 2; attempt <= 3; attempt++) {
      assert.equal(await prepareRetake(root, { index: '0000', severity: 'major', reason: 'The sentence is missing.' }, 3), true);
      seed += 7919; await materialize();
    }
    assert.equal(await prepareRetake(root, { index: '0000', severity: 'major', reason: 'The sentence is missing.' }, 3), false);
    assert.equal(await readFile(wav, 'utf8'), 'recording at seed ' + seed);
    assert.equal(await prepareRetake(root, { index: '0000', severity: 'minor', reason: 'One short hesitation remains.' }, 3), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('queue accepts standalone story IDs and requires bounded repairs and explicit local settings', () => {
  const config = { fiction: 'lantern-pilot', edition: 'breeze', directory: '/queue', state: '/state', tooling: '/tooling',
    credential: '/private/auth.json', python: '/python', asrPython: '/asr', phonemePython: '/phoneme', trials: ['/trial'],
    source: 'a'.repeat(40), title: 'The Lantern', author: '', analysisModel: 'test-model', listenerUrl: 'http://localhost:8080',
    listenerUsername: 'listener', listenerPasswordFile: '/password', maxRetakes: 3, ownerInstruction: 'Generate this book with the reviewed local voices.' };
  assert.equal(queueSchema.parse(config).publishMinor, true);
  assert.equal(queueSchema.parse({ ...config, fiction: 'my-other-book' }).fiction, 'my-other-book');
  assert.throws(() => queueSchema.parse({ ...config, fiction: '../escape' }));
  assert.throws(() => queueSchema.parse({ ...config, maxRetakes: 99 }));
  assert.throws(() => queueSchema.parse({ ...config, ownerInstruction: '' }));
});
test('current audio-bound approvals resume; stale approvals, wrong source and changed audio do not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'breeze-queue-test-'));
  try {
    await mkdir(join(root, 'segments')); await mkdir(join(root, 'review'));
    const audio = Buffer.from('immutable test audio bytes');
    await writeFile(join(root, 'segments/0000.wav'), audio);
    const receipt = { uid: 'span-1', text: 'The lantern burned.', sha256: sha(audio), seed: 7, model: 'breeze-tts-2' };
    const receiptText = JSON.stringify(receipt); await writeFile(join(root, 'segments/0000.json'), receiptText);
    const review = { receiptSha256: sha(receiptText), audioSha256: sha(audio), transcript: 'The lantern burned.', needsInspection: true };
    const reviewText = JSON.stringify(review); await writeFile(join(root, 'review/0000.json'), reviewText);
    const chapter = { chapterId: 'rr-1', sequence: 1, source: 'a'.repeat(64), analysis: 'b'.repeat(64),
      segments: [{ uid: 'span-1', text: 'The lantern burned.' }] };
    assert.deepEqual(await pendingReviews(root, chapter), ['0000']);
    await writeFile(join(root, 'review-decisions.json'), JSON.stringify({ '0000': { reviewSha256: sha(reviewText),
      reason: 'A minor hesitation remains; content is preserved.', severity: 'minor' } }));
    assert.deepEqual(await pendingReviews(root, chapter), []);
    assert.equal((await currentIssues(root))[0]?.severity, 'minor');
    await writeFile(join(root, 'review/0000.json'), JSON.stringify({ ...review, transcript: 'The light burned.' }));
    assert.deepEqual(await pendingReviews(root, chapter), ['0000']);
    assert.deepEqual(await currentIssues(root), []);
    await assert.rejects(pendingReviews(root, { ...chapter, segments: [{ uid: 'span-1', text: 'Changed source.' }] }), /source\/audio/);
    await writeFile(join(root, 'segments/0000.wav'), 'changed recording');
    await assert.rejects(pendingReviews(root, chapter), /source\/audio/);
    assert.equal(await readFile(join(root, 'segments/0000.json'), 'utf8'), receiptText);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('publication proof checks the served source, audio bytes, ranges and origin before sending credentials', async () => {
  const { verifyPublication } = await import('./breeze-queue.js');
  const { Store } = await import('./store.js');
  const root = await mkdtemp(join(tmpdir(), 'breeze-publication-'));
  try {
    const state = new Store(root), assembly = 'a'.repeat(64), source = 'b'.repeat(64), text = 'The lantern burned.';
    const audio = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
    const chapter = { id: 'chapter-1', sequence: 1, assembly, source, title: 'One', duration: 1, checksum: sha(audio) };
    await state.write('book.json', { defaultEdition: 'qwen', editions: { breeze: { chapters: [chapter] } } });
    await state.write('assemblies/' + assembly + '/metadata.json', { id: assembly, source, duration: 1,
      timeline: [{ segmentId: 'one', start: 0, end: 1, spans: [{ uid: 'span', start: 0, end: text.length }] }] });
    await writeFile(state.path('assemblies/' + assembly + '/chapter.mp3'), audio);
    await state.write('sources/' + source + '.json', { text, contentHash: sha(text), url: 'https://example.org/lantern' });
    const password = join(root, 'password'); await writeFile(password, 'test-only-password');
    const config = { state: root, fiction: 'lantern', listenerUrl: 'http://localhost:8080', listenerUsername: 'listener', listenerPasswordFile: password };
    let calls = 0, badText = false, badRange = false;
    const request: typeof fetch = async (url, init) => {
      calls++; assert.equal(new Headers(init?.headers).get('authorization'), 'Basic ' + Buffer.from('listener:test-only-password').toString('base64'));
      if (String(url).includes('/text/')) return Response.json({ chapterId: chapter.id, source, text: badText ? 'Wrong text.' : text });
      if (new Headers(init?.headers).has('range')) return new Response(badRange ? audio.subarray(1, 33) : audio.subarray(0, 32), { status: 206, headers: { 'content-range': 'bytes 0-31/36' } });
      return new Response(audio);
    };
    const proof = await verifyPublication(config, chapter.id, assembly, request);
    assert.equal(proof.defaultEdition, 'qwen'); assert.equal(proof.rangeStatus, 206); assert.equal(calls, 3);
    badText = true; await assert.rejects(verifyPublication(config, chapter.id, assembly, request), /text source mismatch/); badText = false;
    badRange = true; await assert.rejects(verifyPublication(config, chapter.id, assembly, request), /range verification/);
    const before = calls;
    await assert.rejects(verifyPublication({ ...config, listenerUrl: 'http://public.example.org' }, chapter.id, assembly, request), /HTTPS/);
    await assert.rejects(verifyPublication({ ...config, listenerUrl: 'https://example.org/unexpected' }, chapter.id, assembly, request), /HTTPS/);
    assert.equal(calls, before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
