import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, sha, fingerprint } from './store.js';
import { Pipeline } from './pipeline.js';
import { prepareBook, publishBook } from './book.js';
import { sourceUnits, restoreUnits, restoreUnitResponse, unitResponseSchema } from './analysis-units.js';
import { importedAnalysis, validateAnalysis, voiceAt, resolveCast } from './analysis.js';
import { plan } from './planner.js';
import { Budget, renderSegment, type Renderer, type Ledger } from './audio.js';
import { configSchema, type Config, type Chapter, type Cast, type RawAnalysis, type Assembly, type Segment, type Analysis } from './schema.js';

const voice = (voiceId: string) => ({ voiceId, settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 } });
export const fixtureConfig = (): Config => configSchema.parse({ schemaVersion: 1, fictionId: 'fixture',
  narrator: voice('narrator_voice'), anonymous: voice('anonymous_voice'), protagonistId: 'mara', protagonistUsesNarrator: false,
  narrationRules: 'Thoughts and system messages use narrator.',
  pool: ['adult_clear', 'adult_warm', 'adult_low'].map((v, i) => ({ ...voice(v), tags: ['adult'], rating: 4 + i / 4,
    reserveForMajor: i === 2, sampleAsset: 'a'.repeat(64), ratedBy: 'test-only', notes: 'Synthetic fixture, not a rated human voice.' })),
  policy: { version: 'fixture-v2', model: 'eleven_multilingual_v2', maxCharacters: 500, grouping: 'turn', continuity: 'none',
    dialogueSettings: { stability: 0.5, similarity: 0.75 }, normalization: 'off', seed: 42, joinPauseMs: 20,
    selectedAfterListening: true, listeningEvidence: 'Automated synthetic fixture only' },
  analysis: { model: 'explicit-model-required', promptVersion: 'analysis-v1', maxAttempts: 2, maxOutputTokens: 8000,
    maxCallsPerBatch: 10, usdPerMillionInputTokens: 1, usdPerMillionOutputTokens: 1 },
  budget: { maxCharacters: 100000, maxEstimatedUsd: 10, usdPerThousandCharacters: 0.3, maxAttemptsPerSegment: 2 },
  dictionary: [], providerDictionaries: [],
});
export function fixture(sequence = 1): { chapter: Chapter; raw: RawAnalysis } {
  const parts = ['Mara set the lantern down. ', '“Did he say ‘come alone’?”', ' she asked.\n\n',
    '“He did,”', ' replied the keeper.\n\n', '“Then wait.”', '\nA voice sounded behind the door. ', '“Hurry.”'];
  const text = parts.join('');
  return { chapter: { schemaVersion: 1, fictionId: 'fixture', chapterId: `chapter${sequence}`, sequence,
    url: `https://example.org/original-scene/${sequence}`, title: 'The lantern', text, contentHash: sha(text), retrievedAt: '2026-09-27T00:00:00Z' },
    raw: { aliasUpdates: [], characters: [{ id: 'mara', name: 'Mara', aliases: ['traveler'], portrayal: 'An adult traveler', importance: 'major', tags: ['adult'], evidence: 'Mara', continuityFrom: null },
      { id: 'keeper', name: 'Keeper', aliases: [], portrayal: 'An adult keeper', importance: 'minor', tags: ['adult'], evidence: 'keeper', continuityFrom: null }],
      spans: parts.map((text, i) => ({ text, kind: [1, 3, 5, 7].includes(i) ? 'dialogue' : 'prose',
        speaker: i === 1 || i === 5 ? 'mara' : i === 3 ? 'keeper' : i === 7 ? 'anonymous' : 'narrator',
        certainty: i === 7 ? 'concealed' : 'attributed', confidence: i === 7 ? 0.4 : 0.98, reason: i === 7 ? 'Concealed identity' : 'Explicit attribution' })),
      summary: 'Mara and a keeper hear someone behind a door.' } };
}

// Real decodable PCM WAV for infrastructure tests; this deliberately does not simulate speech quality.
class SyntheticRenderer implements Renderer {
  calls = 0; failAt = Infinity;
  async render(segment: Segment) {
    this.calls++;
    if (this.calls === this.failAt) throw new Error('Simulated interruption');
    const samples = Math.max(4410, segment.characters * 882), bytes = samples * 2;
    const wav = Buffer.alloc(44 + bytes);
    wav.write('RIFF'); wav.writeUInt32LE(36 + bytes, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(88200, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
    for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i / 44100 * 440 * 2 * Math.PI) * 5000), 44 + i * 2);
    return { audio: wav, requestId: `request-${this.calls}`, billedCredits: segment.characters };
  }
}
const emptyCast: Cast = { schemaVersion: 1, members: [] };
async function setup(fn: (p: Pipeline, store: Store) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'audiobook-test-'));
  try {
    const store = new Store(directory), p = new Pipeline(store), config = fixtureConfig();
    const { chapter, raw } = fixture(), analysis = importedAnalysis(raw, chapter, emptyCast);
    const segment = plan(chapter, analysis, resolveCast(emptyCast, analysis, chapter, config), config)[0]!;
    const sample = await new SyntheticRenderer().render(segment);
    const { atomic } = await import('./store.js');
    await atomic(store.path(`assets/${'a'.repeat(64)}/audio.mp3`), sample.audio);
    await store.write(`assets/${'a'.repeat(64)}/metadata.json`, { fingerprint: 'a'.repeat(64), checksum: sha(sample.audio) });
    await p.configure(config); await fn(p, store);
  }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function imported(p: Pipeline) { const { chapter, raw } = fixture(); await p.ingest(chapter); await p.importAnalysis(chapter.chapterId, raw); return chapter; }
async function delivered(store: Store, batch: string) {
  const manifest = (await store.read<{ chapters: { assembly: string }[] }>(`deliveries/${batch}/manifest.json`))!;
  return (await store.read<Assembly>(`assemblies/${manifest.chapters[0]!.assembly}/metadata.json`))!;
}

test('exact coverage includes mixed dialogue, nested quotes, layout and Unicode', () => {
  const { chapter, raw } = fixture(); const spans = validateAnalysis(raw, chapter, emptyCast);
  assert.equal(spans.map(s => s.text).join(''), chapter.text);
  assert.equal(spans.at(-1)!.end, chapter.text.length);
  for (const text of ['wrong', '', chapter.text + 'invented']) {
    const bad = structuredClone(raw); bad.spans[0]!.text = text;
    assert.throws(() => validateAnalysis(bad, chapter, emptyCast));
  }
  const reordered = structuredClone(raw); reordered.spans.reverse();
  assert.throws(() => validateAnalysis(reordered, chapter, emptyCast), /coverage/);
});
test('unsupported identities and invented evidence fail before TTS', () => {
  const { chapter, raw } = fixture(); raw.spans[1]!.speaker = 'future-reveal';
  assert.throws(() => validateAnalysis(raw, chapter, emptyCast), /Unsupported/);
  raw.spans[1]!.speaker = 'mara'; raw.characters[0]!.evidence = 'future fact';
  assert.throws(() => validateAnalysis(raw, chapter, emptyCast), /evidence/);
});
test('unique exact text keeps span identity when source offsets shift', () => {
  const { chapter, raw } = fixture(); const first = importedAnalysis(raw, chapter, emptyCast);
  const edited = structuredClone(raw); edited.spans[0]!.text = 'At dusk, ' + edited.spans[0]!.text;
  const source = { ...chapter, text: edited.spans.map(s => s.text).join('') };
  source.contentHash = sha(source.text);
  const second = importedAnalysis(edited, source, emptyCast, first);
  assert.notEqual(second.spans[0]!.uid, first.spans[0]!.uid);
  assert.equal(second.spans[1]!.uid, first.spans[1]!.uid);
  assert.equal(second.spans[1]!.start, first.spans[1]!.start + 9);
});
test('cast stable IDs, reserved major voices and protagonist narration policy', () => {
  const { chapter, raw } = fixture(), config = fixtureConfig();
  const analysis = importedAnalysis(raw, chapter, emptyCast);
  const cast = resolveCast(emptyCast, analysis, chapter, config);
  assert.equal(cast.members[0]!.voices[0]!.voiceId, 'adult_low');
  assert.notEqual(cast.members[1]!.voices[0]!.voiceId, 'adult_low');
  assert.deepEqual(resolveCast(cast, analysis, chapter, config), cast);
  config.protagonistUsesNarrator = true;
  assert.equal(resolveCast(emptyCast, analysis, chapter, config).members[0]!.voices[0]!.voiceId, config.narrator.voiceId);
});
test('concealed and uncertain remain distinct while using anonymous voice', () => {
  const { chapter, raw } = fixture(); raw.spans[1]!.certainty = 'uncertain';
  raw.characters = raw.characters.filter(c => c.id !== 'mara'); raw.spans[5]!.speaker = 'anonymous'; raw.spans[5]!.certainty = 'uncertain';
  const analysis = importedAnalysis(raw, chapter, emptyCast);
  assert.equal(analysis.spans[1]!.speaker, 'anonymous');
  assert.equal(analysis.spans[7]!.certainty, 'concealed');
  assert.equal(voiceAt('concealed:behind-door', 1, 0, emptyCast, fixtureConfig()).voiceId, 'anonymous_voice');
});
test('v3 enforces character and voice limits; v2 never mixes voice IDs', () => {
  const { chapter, raw } = fixture(), config = fixtureConfig(), analysis = importedAnalysis(raw, chapter, emptyCast);
  const cast = resolveCast(emptyCast, analysis, chapter, config);
  const v2 = plan(chapter, analysis, cast, config);
  assert(v2.every(s => new Set(s.turns.map(t => t.voice.voiceId)).size === 1));
  config.policy = { ...config.policy, model: 'eleven_v3', maxCharacters: 80, grouping: 'scene' };
  const v3 = plan(chapter, analysis, cast, config);
  assert(v3.every(s => s.characters <= 80 && new Set(s.turns.map(t => t.voice.voiceId)).size <= 10));
  assert.equal(v3.flatMap(s => s.turns.map(t => t.text)).join(''), chapter.text);
  assert.throws(() => configSchema.parse({ ...config, policy: { ...config.policy, continuity: 'requests' } }));
});
test('pronunciation and attribution edits invalidate only dependent turn assets', () => {
  const { chapter, raw } = fixture(), config = fixtureConfig(), analysis = importedAnalysis(raw, chapter, emptyCast);
  const cast = resolveCast(emptyCast, analysis, chapter, config), baseline = plan(chapter, analysis, cast, config);
  config.dictionary = [{ term: 'lantern', spoken: 'lan tern', version: 'v1' }];
  const revised = plan(chapter, analysis, cast, config);
  assert.equal(baseline.filter((s, i) => s.fingerprint !== revised[i]!.fingerprint).length, 1);
  const repaired = plan(chapter, analysis, cast, config, [{ spanId: analysis.spans[3]!.uid, speaker: 'mara', reason: 'Wrong speaker', take: 1 }]);
  assert.equal(repaired.filter((s, i) => s.fingerprint !== revised[i]!.fingerprint).length, 1);
});
test('production defaults to v3 and Flash scenes preserve every speaker and source character', () => {
  const config = fixtureConfig(), { model: _model, ...policy } = config.policy;
  const defaultConfig = configSchema.parse({ ...config, policy: { ...policy, grouping: 'scene' } });
  assert.equal(defaultConfig.policy.model, 'eleven_v3');
  const { chapter, raw } = fixture(), analysis = importedAnalysis(raw, chapter, emptyCast);
  const cast = resolveCast(emptyCast, analysis, chapter, config);
  const v3 = plan(chapter, analysis, cast, defaultConfig);
  assert(v3.some(s => new Set(s.turns.map(t => t.voice.voiceId)).size > 1));
  const flashConfig = configSchema.parse({ ...defaultConfig,
    policy: { ...defaultConfig.policy, model: 'eleven_flash_v2_5' } });
  const flash = plan(chapter, analysis, cast, flashConfig);
  assert.equal(flash.flatMap(s => s.turns.map(t => t.text)).join(''), chapter.text);
  assert.deepEqual(flash.flatMap(s => s.turns.map(t => t.voice)), v3.flatMap(s => s.turns.map(t => t.voice)));
  for (const segment of flash) {
    assert.equal(new Set(segment.turns.map(t => fingerprint(t.voice))).size, 1);
    assert.equal(segment.request.model_id, 'eleven_flash_v2_5');
    assert.equal(segment.request.text, segment.turns.map(t => t.text).join(''));
    assert.deepEqual(segment.request.voice_settings, segment.turns[0]!.voice.settings);
    assert.equal(segment.request.inputs, undefined);
    assert(!v3.some(s => s.fingerprint === segment.fingerprint));
  }
  assert.throws(() => plan(chapter, analysis, cast, flashConfig,
    [{ spanId: analysis.spans[1]!.uid, tag: '[angry]', reason: 'Acting direction', take: 0 }]), /tags require a v3/);
});
test('switching production modes preserves casting, separates batches and reuses earlier v3 audio', async () => setup(async (p, store) => {
  const v3 = await p.config();
  v3.policy = { ...v3.policy, model: 'eleven_v3', grouping: 'scene' };
  await p.configure(v3); await imported(p);
  const renderer = new SyntheticRenderer();
  await p.run('v3', renderer);
  const cast = await p.cast(), original = await delivered(store, 'v3'), calls = renderer.calls;
  const flash = configSchema.parse({ ...v3,
    policy: { ...v3.policy, version: 'flash', model: 'eleven_flash_v2_5', grouping: 'turn' } });
  await p.configure(flash);
  await assert.rejects(p.run('v3', renderer), /inputs changed/);
  await p.run('flash', renderer);
  const second = await delivered(store, 'flash');
  assert.equal(renderer.calls - calls, second.timeline.length);
  assert.deepEqual(await p.cast(), cast);
  assert(second.timeline.every(s => !original.timeline.some(t => t.asset === s.asset)));
  const ledger = (await store.read<Ledger>('jobs/flash/ledger.json'))!;
  assert(ledger.charges.every(c => c.model === 'eleven_flash_v2_5'));
  const afterFlash = renderer.calls;
  await p.configure(v3); await p.run('v3-again', renderer);
  assert.equal(renderer.calls, afterFlash);
  assert.equal((await delivered(store, 'v3-again')).id, original.id);
}));
test('ingestion is immutable, idempotent, validates hashes and rejects conflicting order', async () => setup(async p => {
  const { chapter } = fixture(), first = await p.ingest(chapter);
  assert.equal(await p.ingest({ ...chapter, retrievedAt: '2026-09-28T00:00:00Z' }), first);
  const text = chapter.text + '\n';
  const next = await p.ingest({ ...chapter, text, contentHash: sha(text) }); assert.notEqual(next, first);
  assert.equal((await p.store.read<Chapter>(`sources/${first}.json`))!.text, chapter.text);
  await assert.rejects(p.ingest({ ...chapter, text }), /hash/);
  await assert.rejects(p.ingest({ ...chapter, chapterId: 'conflict' }), /sequence/);
}));
test('concurrent writers cannot enter the state store', async () => setup(async (_p, store) => {
  await store.lock(async () => { await assert.rejects(store.lock(async () => undefined), /locked/); });
  await store.lock(async () => undefined);
}));
test('interruption resumes from cached assets, publishes atomically and repairs one line', async () => setup(async (p, store) => {
  await imported(p); const renderer = new SyntheticRenderer(); renderer.failAt = 3;
  await assert.rejects(p.run('first', renderer), /interruption/);
  assert.equal(await store.read('deliveries/first/manifest.json'), undefined);
  const initialCalls = renderer.calls; renderer.failAt = Infinity;
  await p.run('first', renderer);
  const first = await delivered(store, 'first');
  assert.equal(renderer.calls - initialCalls, first.timeline.length - 2);
  const count = renderer.calls;
  await p.run('second', renderer); assert.equal(renderer.calls, count);
  const issue = await p.locate(first.id, first.timeline[3]!.start + 0.01);
  await p.correct(first.id, { spanId: issue.spans[0]!.uid, speaker: 'mara', reason: 'Wrong line voice', take: 1 });
  await p.run('repair', renderer, 'repair'); assert.equal(renderer.calls, count + 1);
  const repaired = await delivered(store, 'repair');
  assert.notEqual(repaired.id, first.id);
  assert.equal(sha(await readFile(store.path(`assemblies/${first.id}/chapter.mp3`))), first.checksum);
  assert.equal(first.timeline.filter((s, i) => s.asset !== repaired.timeline[i]!.asset).length, 1);
}));
test('corrupt cached audio is rejected instead of silently charging again', async () => setup(async (p, store) => {
  await imported(p); const renderer = new SyntheticRenderer(); await p.run('first', renderer);
  const assembly = await delivered(store, 'first'), before = renderer.calls;
  await writeFile(store.path(`assets/${assembly.timeline[0]!.asset}/audio.mp3`), 'broken');
  await assert.rejects(p.run('second', renderer), /checksum/); assert.equal(renderer.calls, before);
}));
test('budget persists before rendering and remains enforced after restart', async () => setup(async (p, store) => {
  await imported(p); const config = await p.config(); config.budget.maxCharacters = 30; await p.configure(config);
  const renderer = new SyntheticRenderer(); await assert.rejects(p.run('limited', renderer), /ceiling/);
  assert.equal(renderer.calls, 1);
  await assert.rejects(p.run('limited', renderer), /ceiling/); assert.equal(renderer.calls, 1);
  const ledger = await store.read<Ledger>('jobs/limited/ledger.json'); assert.equal(ledger!.charges.length, 1);
}));
test('review details remain sealed until explicitly listened, with neutral labels', async () => setup(async (p, store) => {
  await imported(p); await p.run('first', new SyntheticRenderer());
  const sealed = JSON.stringify(await p.reviews()); assert(!sealed.includes('Concealed')); assert(!sealed.includes('span_'));
  assert.equal((await p.reviews()).sealedCount, 1);
  await p.progress({ chapter: 1, offset: 0 });
  const visible = await p.reviews(); assert.equal(visible.items.length, 1); assert.equal(visible.items[0]!.label, 'Listening follow-up');
  assert.equal((await delivered(store, 'first')).sequence, 1);
}));
test('later chapter uses existing characters without changing initial voices', async () => setup(async (p, store) => {
  await imported(p); const firstCast = await p.cast();
  const next = fixture(2); next.raw.characters = []; await p.ingest(next.chapter); await p.importAnalysis(next.chapter.chapterId, next.raw);
  await p.run('two', new SyntheticRenderer());
  assert.deepEqual(await p.cast(), firstCast);
  assert.equal((await store.read<{ chapters: unknown[] }>('deliveries/two/manifest.json'))!.chapters.length, 2);
}));
test('new source text changes only its render dependency', async () => setup(async (p, store) => {
  await imported(p); const renderer = new SyntheticRenderer(); await p.run('first', renderer); const calls = renderer.calls;
  const changed = fixture(); changed.raw.characters = [];
  // Same-length change avoids shifting the effective casting position in this test.
  changed.raw.spans[0]!.text = changed.raw.spans[0]!.text.replace('lantern', 'compass');
  changed.chapter.text = changed.raw.spans.map(s => s.text).join(''); changed.chapter.contentHash = sha(changed.chapter.text);
  await p.ingest(changed.chapter); await p.importAnalysis(changed.chapter.chapterId, changed.raw);
  await p.run('changed', renderer); assert.equal(renderer.calls, calls + 1);
  const before = await delivered(store, 'first'), after = await delivered(store, 'changed'); assert.notEqual(before.source, after.source);
}));
test('production model cannot be selected without a listening record', async () => setup(async p => {
  await imported(p); const config = await p.config(); config.policy.selectedAfterListening = false; await p.configure(config);
  await assert.rejects(p.run('blocked', new SyntheticRenderer()), /pilot/);
}));
test('v2 stitching pins completed bytes after provider request IDs expire', async () => setup(async (p, store) => {
  const config = await p.config(); config.policy.continuity = 'requests';
  const { chapter, raw } = fixture(), analysis = importedAnalysis(raw, chapter, emptyCast), cast = resolveCast(emptyCast, analysis, chapter, config);
  const segments = plan(chapter, analysis, cast, config), renderer = new SyntheticRenderer();
  const budget = new Budget(store, 'stitch', config, { charges: [] });
  const segment = segments[0]!; segment.previousSegment = 'preceding';
  const prior = { schemaVersion: 1 as const, fingerprint: 'a'.repeat(64), checksum: 'b'.repeat(64), duration: 1, frames: 44100,
    requestId: 'recent-request', generatedAt: new Date().toISOString(), billedCredits: 1, request: {}, model: 'eleven_multilingual_v2', characters: 1 };
  const first = await renderSegment(store, segment, config, budget, renderer, 1, prior);
  assert.deepEqual(first.request.previous_request_ids, ['recent-request']);
  prior.generatedAt = '2000-01-01T00:00:00Z';
  const cached = await renderSegment(store, segment, config, budget, renderer, 1, prior);
  assert.equal(cached.checksum, first.checksum); assert.equal(renderer.calls, 1);
}));

test('source deletion moves voice anchors without recasting unchanged speech', async () => setup(async (p, store) => {
  await imported(p); const renderer = new SyntheticRenderer(); await p.run('first', renderer); const calls = renderer.calls;
  const changed = fixture(); changed.raw.characters = []; changed.raw.spans[0]!.text = 'Mara waited. ';
  changed.chapter.text = changed.raw.spans.map(s => s.text).join(''); changed.chapter.contentHash = sha(changed.chapter.text);
  await p.ingest(changed.chapter); await p.importAnalysis(changed.chapter.chapterId, changed.raw);
  await p.run('shorter', renderer); assert.equal(renderer.calls, calls + 1);
  const before = await delivered(store, 'first'), after = await delivered(store, 'shorter');
  assert.equal(before.timeline[1]!.asset, after.timeline[1]!.asset);
  assert.equal((await p.cast()).members[0]!.first.offset, changed.raw.spans[0]!.text.length);
}));
test('story-time voice version changes later speech and preserves earlier dialogue', async () => setup(async (p, store) => {
  await imported(p); const renderer = new SyntheticRenderer(); await p.run('first', renderer); const calls = renderer.calls;
  const before = await delivered(store, 'first');
  const analysis = (await store.read<Analysis>(`analyses/${before.analysis}.json`))!;
  await p.changeVoice('mara', voice('transformed_voice'), { chapter: 1, offset: analysis.spans[5]!.start }, 'Voice changes in the story');
  await p.run('transformed', renderer, 'repair'); assert.equal(renderer.calls, calls + 1);
  const after = await delivered(store, 'transformed');
  assert.equal(before.timeline[1]!.asset, after.timeline[1]!.asset);
  assert.notEqual(before.timeline[5]!.asset, after.timeline[5]!.asset);
  await assert.rejects(p.run('first', renderer), /inputs changed/);
}));
test('pool entries require saved audio evidence', async () => setup(async p => {
  const config = await p.config(); config.pool[0]!.sampleAsset = 'b'.repeat(64);
  await assert.rejects(p.configure(config), /saved audition/);
}));

test('selecting a later chapter cannot consume stale intervening summaries', async () => setup(async p => {
  await imported(p);
  for (const sequence of [2, 3]) {
    const next = fixture(sequence); next.raw.characters = [];
    await p.ingest(next.chapter); await p.importAnalysis(next.chapter.chapterId, next.raw);
  }
  const changed = fixture(); changed.raw.characters = []; changed.raw.summary = 'Corrected earlier context.';
  await p.importAnalysis(changed.chapter.chapterId, changed.raw);
  await assert.rejects(p.earlierContext(3), /Earlier story context changed/);
}));

test('prepared chapters preview without speech; publication validates model and preserves edition history', async () => setup(async (p, store) => {
  const config = await p.config(); config.policy.model = 'eleven_v3'; await p.configure(config);
  await imported(p);
  const preview = await prepareBook(p, 'preview');
  assert.equal(preview.chapters.length, 1);
  assert.equal(preview.chapters[0]!.characters, fixture().chapter.text.length);
  assert.equal(await store.read('jobs/preview/ledger.json'), undefined);
  await assert.rejects(publishBook(p, 'missing', 'v3', 'Test', 'Author'), /completed/);
  await p.run('v3-book', new SyntheticRenderer());
  await assert.rejects(publishBook(p, 'v3-book', 'flash', 'Test', 'Author'), /model/);
  await assert.rejects(publishBook(p, 'v3-book', 'qwen', 'Test', 'Author'), /model/);
  await publishBook(p, 'v3-book', 'v3', 'Test', 'Author');
  const book = (await store.read<{ editions: { v3: { chapters: { assembly: string }[] } } }>('book.json'))!;
  assert.equal(book.editions.v3.chapters.length, 1);
  assert.equal((await store.list('book-history')).length, 1);
  const original = (await store.read<Assembly>(`assemblies/${book.editions.v3.chapters[0]!.assembly}/metadata.json`))!;
  const localPlan = await store.object('plans', { policy: { model: 'qwen-base' } });
  const local = { ...original, id: fingerprint({ original: original.id, localPlan }), plan: localPlan };
  await store.write(`assemblies/${local.id}/metadata.json`, local);
  await writeFile(store.path(`assemblies/${local.id}/chapter.mp3`), await readFile(store.path(`assemblies/${original.id}/chapter.mp3`)));
  await store.write('deliveries/local-book/manifest.json', { chapters: [{ sequence: 1, assembly: local.id }] });
  await assert.rejects(publishBook(p, 'local-book', 'breeze', 'Test', 'Author'), /model/);
  await publishBook(p, 'local-book', 'qwen', 'Test', 'Author');
  const blockedPlan = await store.object('plans', { policy: { model: 'qwen-base' }, quality: { status: 'blocked' } });
  const blocked = { ...local, id: fingerprint({ blockedPlan }), plan: blockedPlan };
  await store.write(`assemblies/${blocked.id}/metadata.json`, blocked);
  await writeFile(store.path(`assemblies/${blocked.id}/chapter.mp3`), await readFile(store.path(`assemblies/${original.id}/chapter.mp3`)));
  await store.write('deliveries/blocked-draft/manifest.json', { chapters: [{ sequence: 1, assembly: blocked.id }] });
  await assert.rejects(publishBook(p, 'blocked-draft', 'qwen', 'Test', 'Author'), /unresolved major/);
  const afterBlocked = (await store.read<{ editions: { qwen: { chapters: { assembly: string }[] } } }>('book.json'))!;
  assert.equal(afterBlocked.editions.qwen.chapters[0]!.assembly, local.id);
  const updated = (await store.read<any>('book.json'))!;
  assert.equal(updated.defaultEdition, 'v3');
  assert.equal(updated.editions.v3.chapters[0].assembly, original.id);
  assert.equal(updated.editions.qwen.chapters[0].assembly, local.id);
  assert.equal((await store.list('book-history')).length, 2);
  const externalPlan = await store.object('plans', { policy: { model: 'future-provider-model' } });
  const external = { ...original, id: fingerprint({ externalPlan }), plan: externalPlan };
  await store.write(`assemblies/${external.id}/metadata.json`, external);
  await writeFile(store.path(`assemblies/${external.id}/chapter.mp3`), await readFile(store.path(`assemblies/${original.id}/chapter.mp3`)));
  await store.write('deliveries/external/manifest.json', { chapters: [{ sequence: 1, assembly: external.id }] });
  await publishBook(p, 'external', 'Custom-provider_42', 'Test', 'Author');
  const published = (await store.read<any>('book.json'))!;
  assert.equal(published.editions['Custom-provider_42'].chapters[0].assembly, external.id);
  assert.equal(published.defaultEdition, 'v3');
  assert.equal(published.editions.qwen.chapters[0].assembly, local.id);
  await assert.rejects(publishBook(p, 'external', '../invalid', 'Test', 'Author'));

}));

test('numbered analysis restores exact quotes, whitespace and Unicode and rejects omitted units', () => {
  const text = 'A\n\n“Hello \'friend\'.”\n\n"Goodbye." End 🦋\n';
  const units = sourceUnits(text);
  assert.equal(units.join(''), text);
  assert(units.some(u => u.trim() === '“Hello \'friend\'.”'));
  const labels = units.map((_, unit) => ({ unit, kind: 'prose', speaker: 'narrator', certainty: 'attributed', confidence: 1, reason: '' }));
  const raw = { characters: [], aliasUpdates: [], units: labels, summary: '' };
  assert.equal(restoreUnits(raw, units).spans.map(s => s.text).join(''), text);
  assert.throws(() => restoreUnits({ ...raw, units: labels.slice(1) }, units), /cover/);
  assert.throws(() => restoreUnits({ ...raw, units: labels.slice().reverse() }, units), /cover/);
});

test('analysis schema requires every source label and reconstructs without model-written text', () => {
  const units = ['One. ', '“Two.”'];
  const label = { kind: 'prose', speaker: 'narrator', certainty: 'attributed', confidence: 1, reason: '' };
  const response = { characters: [], aliasUpdates: [], summary: '', labels: { unit_0: label, unit_1: label } };
  assert.equal(restoreUnitResponse(response, units).spans.map(s => s.text).join(''), units.join(''));
  assert.throws(() => restoreUnitResponse({ ...response, labels: { unit_0: label } }, units), /Missing/);
  const schema = unitResponseSchema(units.length) as any;
  assert.deepEqual(schema.properties.labels.required, ['unit_0', 'unit_1']);
});

test('mixed quotation marks do not swallow narration or turn attribution into character speech', () => {
  const text = '“A book title"\n\nShe waited. “Hello,” she said. "Goodbye.”';
  const units = sourceUnits(text);
  assert.equal(units.join(''), text);
  assert.equal(units[0]!.trim(), '“A book title"');
  assert(units.includes('“Hello,”'));
  const label = { kind: 'dialogue', speaker: 'alice', certainty: 'attributed', confidence: 0.9, reason: '' };
  const response = { characters: [], aliasUpdates: [], summary: '',
    labels: Object.fromEntries(units.map((_, i) => [`unit_${i}`, label])) };
  const restored = restoreUnitResponse(response, units);
  assert.equal(restored.spans.find(s => s.text.includes('she said'))!.speaker, 'narrator');
  assert.equal(restored.spans.find(s => s.text === '“Hello,”')!.speaker, 'alice');
});

test('continued multi-paragraph speech keeps repeated opening quotes inside dialogue', () => {
  const speech = '"First: the duels.\n\n"That means think carefully. Especially—"';
  const text = speech + ' her gaze shifted, "—when facing a stronger opponent."\n\nHe nodded.\n\n"Understood," he replied.';
  const units = sourceUnits(text);
  assert.equal(units.join(''), text);
  assert.equal(units[0], speech);
  assert(units.includes(' her gaze shifted, '));
  assert(units.some(u => u.trim() === 'He nodded.'));
  assert(units.includes('"Understood,"'));
});

test('curly quotations inside straight-quoted speech do not swallow narration boundaries', () => {
  const first = '"The “if” clauses matter. That is the strongest part of the upgrade."';
  const narration = '\n\nShe paused, pacing around her room. ';
  const second = '"There is still one caveat."';
  const text = first + narration + second;
  const units = sourceUnits(text);
  assert.equal(units.join(''), text);
  assert.equal(units[0]!.trimEnd(), first);
  assert(units.includes('She paused, pacing around her room. '));
  assert.equal(units.at(-1), second);
  assert(!units.some(unit => unit.startsWith('"') && unit.includes('She paused')));
});

test('mixed paragraph-opening quote styles preserve speech and later narration', () => {
  const speech = '"The report arrived.\n\n“A surprising result.\n\n“But the “if” clause still matters."';
  const text = speech + '\n\nShe bowed. "My apologies."\n\n"None needed," he replied.';
  const units = sourceUnits(text);
  assert.equal(units.join(''), text);
  assert.equal(units[0]!.trimEnd(), speech);
  assert(units.includes('She bowed. '));
  assert(units.some(unit => unit.trim() === '"My apologies."'));
  assert(units.includes('"None needed,"'));
  assert(units.some(unit => unit.trim() === 'he replied.'));
});
