import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ElevenLabs, ProviderError, Budget } from './audio.js';
import { analyzeRemote, importedAnalysis, resolveCast, rosterAt } from './analysis.js';
import { plan } from './planner.js';
import { auditionSegment } from './audition.js';
import { Store, sha, fingerprint } from './store.js';
import { configSchema, type Chapter, type RawAnalysis, type Cast } from './schema.js';

const settings = { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 };
const config = () => configSchema.parse({ schemaVersion: 1, fictionId: 'test',
  narrator: { voiceId: 'narrator', settings }, anonymous: { voiceId: 'anonymous', settings },
  protagonistId: null, protagonistUsesNarrator: false, narrationRules: 'Narrate prose.', pool: [],
  policy: { version: 'v1', model: 'eleven_v3', maxCharacters: 1800, grouping: 'scene', continuity: 'none',
    dialogueSettings: { stability: 0.5, similarity: 0.75 }, normalization: 'auto', seed: null, joinPauseMs: 0,
    selectedAfterListening: false, listeningEvidence: '' },
  analysis: { model: 'test-model', promptVersion: 'v1', maxAttempts: 2, maxOutputTokens: 1000,
    maxCallsPerBatch: 2, usdPerMillionInputTokens: 1, usdPerMillionOutputTokens: 1 },
  budget: { maxCharacters: 100, maxEstimatedUsd: 1, usdPerThousandCharacters: 1, maxAttemptsPerSegment: 1 },
  dictionary: [], providerDictionaries: [] });
const source = (): Chapter => ({ schemaVersion: 1, fictionId: 'test', chapterId: 'one', sequence: 1,
  url: 'https://example.org/one', title: 'Test', text: 'A lantern glowed.', contentHash: sha('A lantern glowed.'), retrievedAt: '2026-09-27T00:00:00Z' });
const raw = (): RawAnalysis => ({ characters: [], aliasUpdates: [], spans: [{ text: 'A lantern glowed.', kind: 'prose',
  speaker: 'narrator', certainty: 'attributed', confidence: 1, reason: 'Prose' }], summary: 'A lantern glowed.' });
const empty: Cast = { schemaVersion: 1, members: [] };
test('scene auditions preserve actors, exact source offsets and bill delivery tags', () => {
  const c = config(), voice = { voiceId: 'actor', settings };
  const segment = auditionSegment({ model: 'eleven_v3', turns: [
    { voice, text: 'Hello! ', tag: '[cheerfully]' }, { voice: c.narrator, text: 'She smiled.' },
  ] }, c);
  assert.deepEqual(segment.request.inputs, [{ voice_id: 'actor', text: '[cheerfully] Hello! ' },
    { voice_id: 'narrator', text: 'She smiled.' }]);
  assert.equal(segment.characters, '[cheerfully] Hello! She smiled.'.length);
  assert.deepEqual(segment.turns.map(t => [t.start, t.end]), [[0, 7], [7, 18]]);
  assert.equal(segment.turns.map(t => t.text).join(''), 'Hello! She smiled.');
  assert.throws(() => auditionSegment({ model: 'eleven_multilingual_v2', turns: [{ voice, text: 'Hi' }] }, c));
  assert.throws(() => auditionSegment({ model: 'eleven_v3', turns: [{ voice, text: '\n\n' }] }, c));
  assert.throws(() => auditionSegment({ model: 'eleven_v3', turns: [{ voice, text: 'x'.repeat(2000), tag: '[sad]' }] }, c), /2000/);
  assert.throws(() => auditionSegment({ model: 'eleven_v3', turns: Array.from({ length: 11 }, (_, i) =>
    ({ voice: { ...voice, voiceId: `actor${i}` }, text: 'Hi' })) }, c), /10 voices/);
});
test('single-voice auditions retain existing paid cache identities', () => {
  const c = config(), voice = c.narrator;
  const segment = auditionSegment({ voice, text: 'Hello.', model: 'eleven_v3' }, c);
  assert.equal(segment.fingerprint, fingerprint({ request: { model_id: 'eleven_v3', apply_text_normalization: 'auto',
    inputs: [{ voice_id: voice.voiceId, text: 'Hello.' }], settings: c.policy.dialogueSettings }, voice, format: 'mp3_44100_128' }));
});
async function fakeFetch(fn: (url: string, init: RequestInit) => Response | Promise<Response>, run: () => Promise<void>) {
  const old = globalThis.fetch;
  const oldEleven = process.env.ELEVENLABS_API_KEY, oldOpenai = process.env.OPENAI_API_KEY;
  process.env.ELEVENLABS_API_KEY = 'test-credential'; process.env.OPENAI_API_KEY = 'test-credential';
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(fn(String(url), init!))) as typeof fetch;
  try { await run(); } finally {
    globalThis.fetch = old;
    if (oldEleven === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = oldEleven;
    if (oldOpenai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenai;
  }
}

test('ElevenLabs adapters send exact supported v3 and v2 shapes and capture usage', async () => {
  for (const model of ['eleven_v3', 'eleven_multilingual_v2'] as const) {
    const c = config(); c.policy.model = model;
    const segment = plan(source(), importedAnalysis(raw(), source(), empty), empty, c)[0]!;
    await fakeFetch((url, init) => {
      assert(url.endsWith('?output_format=mp3_44100_128'));
      const body = JSON.parse(String(init.body));
      assert.equal(body.model_id, model);
      assert(!JSON.stringify(body).includes('test-credential'));
      if (model === 'eleven_v3') {
        assert(url.includes('/text-to-dialogue?')); assert.deepEqual(body.inputs, [{ text: source().text, voice_id: 'narrator' }]);
        assert.deepEqual(body.settings, c.policy.dialogueSettings); assert.equal(body.voice_settings, undefined);
      } else { assert(url.includes('/text-to-speech/narrator?')); assert.equal(body.text, source().text); assert.deepEqual(body.voice_settings, settings); }
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'request-id': 'request-1', 'character-cost': '17' } });
    }, async () => {
      const rendered = await new ElevenLabs().render(segment, segment.request);
      assert.equal(rendered.requestId, 'request-1'); assert.equal(rendered.billedCredits, 17);
    });
  }
});
test('Flash auditions use single-voice speech and keep model-specific cache identities', async () => {
  const c = config(), voice = c.narrator, text = source().text;
  const segment = auditionSegment({ voice, text, model: 'eleven_flash_v2_5' }, c);
  assert.notEqual(segment.fingerprint, auditionSegment({ voice, text, model: 'eleven_multilingual_v2' }, c).fingerprint);
  assert.throws(() => auditionSegment({ model: 'eleven_flash_v2_5', turns: [{ voice, text }] }, c));
  await fakeFetch((url, init) => {
    assert(url.includes('/text-to-speech/narrator?'));
    assert.deepEqual(JSON.parse(String(init.body)), { model_id: 'eleven_flash_v2_5',
      apply_text_normalization: 'auto', text, voice_settings: settings });
    return new Response(new Uint8Array([1, 2]), { headers: { 'character-cost': '7.5' } });
  }, async () => {
    assert.equal((await new ElevenLabs().render(segment, segment.request)).billedCredits, 7.5);
  });
});
test('provider error bodies are not exposed', async () => {
  const segment = plan(source(), importedAnalysis(raw(), source(), empty), empty, config())[0]!;
  await fakeFetch(() => new Response('Private provider body', { status: 401 }), async () => {
    await assert.rejects(new ElevenLabs().render(segment, segment.request), (e: unknown) =>
      e instanceof ProviderError && e.message === 'ElevenLabs HTTP 401');
  });
});
test('provider diagnostics expose only recognized error codes', async () => {
  const segment = plan(source(), importedAnalysis(raw(), source(), empty), empty, config())[0]!;
  for (const code of ['missing_permissions', 'detected_unusual_activity', 'private-reflected-value']) {
    await fakeFetch(() => Response.json({ detail: { status: code, message: 'test-credential Private source text' } },
      { status: 401 }), async () => {
      await assert.rejects(new ElevenLabs().render(segment, segment.request), (e: unknown) => {
        assert(e instanceof ProviderError);
        assert.equal(e.message, `ElevenLabs HTTP 401${code === 'private-reflected-value' ? '' : ` (${code})`}`);
        return true;
      });
    });
  }
});
test('analysis repairs invalid source coverage with bounded chapter-scale requests', async () => {
  let calls = 0, reservations = 0;
  await fakeFetch((_url, init) => {
    calls++; const body = JSON.parse(String(init.body));
    assert.equal(body.store, false); assert.equal(body.text.format.type, 'json_schema');
    if (calls === 2) assert(JSON.parse(body.input).validationError.includes('coverage'));
    const answer = raw(); if (calls === 1) answer.spans[0]!.text = 'Invented';
    return Response.json({ status: 'completed', output: [{ type: 'reasoning' }, { type: 'message',
      content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] });
  }, async () => {
    const analysis = await analyzeRemote(source(), config(), '', empty, async () => { reservations++; });
    assert.equal(analysis.spans[0]!.text, source().text);
  });
  assert.equal(calls, 2); assert.equal(reservations, 2);
});
test('analysis refusal or truncation cannot reach rendering', async () => {
  await fakeFetch(() => Response.json({ status: 'incomplete', output: [] }), async () => {
    await assert.rejects(analyzeRemote(source(), config(), '', empty, async () => undefined), /bounded repair attempts/);
  });
});
test('future aliases and cast members do not enter earlier prompts', () => {
  const cast: Cast = { schemaVersion: 1, members: [{ id: 'old', name: 'Old name', aliases: [
    { name: 'Revealed name', from: { chapter: 5, offset: 0 } }], first: { chapter: 1, offset: 0 },
    evidence: 'Earlier', portrayal: 'Adult', importance: 'minor', voices: [] },
    { id: 'future', name: 'Future', aliases: [], first: { chapter: 9, offset: 0 }, evidence: 'Later', portrayal: '', importance: 'minor', voices: [] }] };
  assert.deepEqual(rosterAt(cast, 2).map(c => c.id), ['old']); assert.deepEqual(rosterAt(cast, 2)[0]!.aliases, []);
});
test('explicit reveal keeps the established concealed voice', () => {
  const s = source(), c = config(), concealed = raw();
  concealed.spans[0] = { ...concealed.spans[0]!, kind: 'dialogue', speaker: 'concealed:door', certainty: 'concealed' };
  const cast = resolveCast(empty, importedAnalysis(concealed, s, empty), s, c);
  const later = { ...s, sequence: 2, text: 'The keeper said hello.', contentHash: sha('The keeper said hello.') };
  const revealed: RawAnalysis = { characters: [{ id: 'keeper', name: 'Keeper', aliases: [], portrayal: 'Adult', importance: 'minor', tags: [],
    evidence: 'keeper', continuityFrom: 'concealed:door' }], aliasUpdates: [], summary: 'The keeper spoke.',
    spans: [{ text: later.text, kind: 'dialogue', speaker: 'keeper', certainty: 'attributed', confidence: 1, reason: 'Explicit reveal' }] };
  const next = resolveCast(cast, importedAnalysis(revealed, later, cast), later, c);
  assert.equal(next.members.find(m => m.id === 'keeper')!.voices[0]!.voiceId, 'anonymous');
});
test('a shared pilot budget stops later trials when earlier ones spent its ceiling', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'audio-budget-'));
  try {
    const store = new Store(directory), c = config(), ledger = { charges: [] };
    const first = new Budget(store, 'pilot', c, ledger);
    await first.reserve('render', 80, 0.8, 'eleven_v3', 1);
    const resumed = new Budget(store, 'pilot', c, (await store.read('jobs/pilot/ledger.json'))!);
    await assert.rejects(resumed.reserve('render', 30, 0.3, 'eleven_multilingual_v2', 1), /ceiling/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
