import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inworld, SpeechProviders, Budget, renderSegment, type Ledger } from './audio.js';
import { configSchema, type Analysis, type Chapter, type Cast } from './schema.js';
import { plan } from './planner.js';
import { Store, sha } from './store.js';
import { Pipeline } from './pipeline.js';
import { publishBook } from './book.js';

const template = JSON.parse(await readFile(new URL('../examples/fiction-inworld.json', import.meta.url), 'utf8')) as unknown;
function fixture(text = 'The lantern glowed beside the road. '): { config: ReturnType<typeof configSchema.parse>; chapter: Chapter; analysis: Analysis; cast: Cast } {
  const config = configSchema.parse(template);
  config.protagonistId = null; config.policy.selectedAfterListening = true;
  config.policy.listeningEvidence = 'Synthetic test fixture only';
  config.budget = { maxCharacters: 10000, maxEstimatedUsd: 1, usdPerThousandCharacters: 0.01, maxAttemptsPerSegment: 1 };
  const chapter: Chapter = { schemaVersion: 1, fictionId: config.fictionId, chapterId: 'chapter-1', sequence: 1,
    url: 'https://example.org/original-scene', title: 'Lantern', text, contentHash: sha(text), retrievedAt: '2026-10-17T00:00:00Z' };
  const analysis: Analysis = { schemaVersion: 1, source: chapter.contentHash, fingerprint: sha(text), model: 'fixture', promptVersion: 'fixture',
    spans: [{ uid: 'one', start: 0, end: text.length, text, kind: 'prose', speaker: 'narrator', certainty: 'attributed', confidence: 1, reason: 'Original synthetic fixture' }],
    characters: [], aliasUpdates: [], summary: 'A lantern glows.' };
  return { config, chapter, analysis, cast: { schemaVersion: 1, members: [] } };
}
function wav(): Buffer {
  const bytes = 88200, audio = Buffer.alloc(44 + bytes);
  audio.write('RIFF'); audio.writeUInt32LE(36 + bytes, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(44100, 24); audio.writeUInt32LE(88200, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(bytes, 40);
  return audio;
}
const originalKey = process.env.INWORLD_API_KEY;
test.after(() => { if (originalKey === undefined) delete process.env.INWORLD_API_KEY; else process.env.INWORLD_API_KEY = originalKey; });
process.env.INWORLD_API_KEY = 'test-portal-credential';

test('Inworld sends Portal credentials unchanged and decodes unary JSON with usage', async () => {
  const { config, chapter, analysis, cast } = fixture();
  const segment = plan(chapter, analysis, cast, config)[0]!;
  let calls = 0;
  const provider = new Inworld(async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.inworld.ai/tts/v1/voice');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Basic test-portal-credential');
    assert.equal(init?.redirect, 'error');
    assert.deepEqual(JSON.parse(String(init?.body)), { text: chapter.text, modelId: 'inworld-tts-2', voiceId: config.narrator.voiceId,
      audioConfig: { audioEncoding: 'MP3', bitRate: 128000, sampleRateHertz: 44100, speakingRate: 1 },
      applyTextNormalization: 'APPLY_TEXT_NORMALIZATION_UNSPECIFIED', deliveryMode: 'BALANCED' });
    return Response.json({ audioContent: wav().toString('base64'), usage: { modelId: segment.model, processedCharactersCount: chapter.text.length } }, { headers: { 'x-request-id': 'inworld-fixture' } });
  });
  const result = await new SpeechProviders({ render: async () => { throw new Error('Wrong provider'); } }, provider).render(segment, segment.request);
  assert.deepEqual(result.audio, wav()); assert.equal(result.billedCredits, chapter.text.length); assert.equal(result.requestId, 'inworld-fixture');
  assert.equal(calls, 1);
});

test('Inworld plans bound UTF-16, preserve surrogate pairs, and separate model caches', () => {
  const { config, chapter, analysis, cast } = fixture('a'.repeat(1798) + '🌙' + 'b'.repeat(2300));
  config.policy.continuity = 'text';
  const segments = plan(chapter, analysis, cast, config);
  assert.equal(segments.map(s => s.request.text).join(''), chapter.text);
  for (const s of segments) {
    const text = String(s.request.text);
    assert.ok(text.length <= 2000); assert.ok(!/[\uD800-\uDBFF]$/u.test(text)); assert.ok(!/^[\uDC00-\uDFFF]/u.test(text));
    assert.ok(!Object.hasOwn(s.request, 'previous_text')); assert.ok(!Object.hasOwn(s.request, 'next_text'));
  }
  assert.deepEqual(segments[1]!.request.synthesisContext, { previousRequests: [{ text: segments[0]!.request.text }] });
  config.policy.model = 'inworld-tts-2-flash';
  const flash = plan(chapter, analysis, cast, config);
  assert.notEqual(flash[0]!.fingerprint, segments[0]!.fingerprint); assert.ok(!Object.hasOwn(flash[0]!.request, 'deliveryMode'));
  assert.throws(() => configSchema.parse({ ...config, policy: { ...config.policy, maxCharacters: 2001 } }), /2000/);
  assert.throws(() => configSchema.parse({ ...config, policy: { ...config.policy, continuity: 'requests' } }), /continuity/);
});

test('Inworld rejects provider bodies, malformed audio, mismatched models, and excessive responses', async () => {
  const { config, chapter, analysis, cast } = fixture(), segment = plan(chapter, analysis, cast, config)[0]!;
  const responses = [new Response('private-source-and-key', { status: 401 }), Response.json({ audioContent: '!!==' }),
    Response.json({ audioContent: 'YQ==', usage: { modelId: 'wrong' } }), Response.json({ audioContent: 'YQ==', usage: { processedCharactersCount: -1 } }),
    new Response('oversized', { headers: { 'content-length': String(25 * 1024 * 1024) } }), new Response('private-invalid-json')];
  for (const response of responses) await assert.rejects(new Inworld(async () => response).render(segment, segment.request), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes('private')); assert.ok(!error.message.includes(process.env.INWORLD_API_KEY!)); return true;
  });
  let called = false;
  await assert.rejects(new Inworld(async () => { called = true; return Response.json({}); }).render(segment, { ...segment.request, text: 'a'.repeat(2001) }), /Invalid Inworld request/);
  assert.equal(called, false);
});

test('Inworld uses the real budget, checksum cache, resume, and publication path without paid calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'inworld-test-'));
  try {
    const store = new Store(directory), pipeline = new Pipeline(store), { config, chapter, analysis, cast } = fixture();
    await pipeline.configure(config); await pipeline.ingest(chapter);
    const { uid: _uid, start: _start, end: _end, ...span } = analysis.spans[0]!;
    await pipeline.importAnalysis(chapter.chapterId, { spans: [span], characters: [], aliasUpdates: [], summary: analysis.summary });
    let calls = 0;
    const renderer = new Inworld(async () => { calls++; return Response.json({ audioContent: wav().toString('base64'), usage: { processedCharactersCount: chapter.text.length } }); });
    const segment = plan(chapter, analysis, cast, config)[0]!;
    const budget = new Budget(store, 'zero', { ...config, budget: { ...config.budget, maxEstimatedUsd: 0 } }, { charges: [] });
    await assert.rejects(renderSegment(store, segment, config, budget, renderer, 1), /ceiling/); assert.equal(calls, 0);
    await pipeline.run('first', renderer, 'batch', [chapter.chapterId]);
    const firstCalls = calls; assert.ok(firstCalls > 0);
    await pipeline.run('first', renderer, 'batch', [chapter.chapterId]); assert.equal(calls, firstCalls);
    await pipeline.run('next', renderer, 'batch', [chapter.chapterId]); assert.equal(calls, firstCalls);
    const publication = await publishBook(pipeline, 'next', 'inworld', 'Lantern', 'Fixture'); assert.equal(publication.edition, 'inworld');
    await assert.rejects(publishBook(pipeline, 'next', 'inworld-flash', 'Lantern', 'Fixture'), /Edition does not match/);
    const ledger = await store.read<Ledger>('jobs/first/ledger.json'); assert.ok(ledger!.charges.some(c => c.status === 'completed' && c.billedCredits === chapter.text.length));
    await assert.rejects(pipeline.experiments('comparison', renderer), /audition Inworld/); assert.equal(calls, firstCalls);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
