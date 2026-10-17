import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openaiAuditionSchema, runOpenaiAudition, reservationAllowed } from './openai-audition.js';
import { sha } from './store.js';
import { readSpeechStream } from './openai-speech-stream.js';
const plan = { model: 'gpt-4o-mini-tts', source: 'Hello.', sourceSha256: sha('Hello.'), maxReservedUsd: 0.25,
  turns: [{ role: 'narrator', voice: 'marin', text: 'Hello.', instructions: 'Tell a story.' }] };
test('OpenAI auditions require complete exact source coverage before spending', () => {
  assert.equal(openaiAuditionSchema.parse(plan).turns[0]?.text, 'Hello.');
  assert.throws(() => openaiAuditionSchema.parse({ ...plan, source: 'Changed.' }));
  assert.throws(() => openaiAuditionSchema.parse({ ...plan, turns: [{ ...plan.turns[0], text: ' ' }] }));
  assert.equal(reservationAllowed([], 0.01), false);
  assert.equal(reservationAllowed(Array.from({length: 12}, (_, turn) => ({ turn, reservedUsd: 0.02, status: 'completed' as const })), 0.25), false);
});
test('failed OpenAI request stays reserved and is never replayed automatically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openai-audition-'));
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only';
  let calls = 0;
  const mock: typeof fetch = async () => { calls++; return new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: 'secret' } }), { status: 429 }); };
  try {
    await assert.rejects(runOpenaiAudition(plan, directory, mock), /429 \(insufficient_quota\)/);
    const ledger = JSON.parse(await readFile(join(directory, 'ledger.json'), 'utf8'));
    assert.equal(ledger.charges[0].status, 'reserved');
    assert.equal(ledger.charges[0].reservedUsd, 0.02);
    assert.equal(ledger.charges[0].httpStatus, 429);
    assert.equal(ledger.charges[0].errorCode, 'insufficient_quota');
    assert.equal(JSON.stringify(ledger).includes('secret'), false);
    await assert.rejects(runOpenaiAudition(plan, directory, mock), /refusing paid replay/);
    assert.equal(calls, 1);
  } finally {
    if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old;
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy models reject unavailable voices and unsupported acting instructions', () => {
  const legacy = { ...plan, model: 'tts-1', turns: [{ role: 'narrator', voice: 'fable', text: 'Hello.' }] };
  assert.equal(openaiAuditionSchema.parse(legacy).model, 'tts-1');
  assert.throws(() => openaiAuditionSchema.parse({ ...legacy, turns: [{ ...legacy.turns[0], voice: 'marin' }] }));
  assert.throws(() => openaiAuditionSchema.parse({ ...legacy, turns: [{ ...legacy.turns[0], instructions: 'Whisper.' }] }));
  assert.throws(() => openaiAuditionSchema.parse({ ...legacy, model: 'gpt-4o-mini-tts' }));
  assert.throws(() => openaiAuditionSchema.parse({ ...legacy, streamFormat: 'sse' }));
});

function speechEvents(withDone = true) {
  return ': comment\r\n\r\ndata: ' + JSON.stringify({ type: 'speech.audio.delta', audio: Buffer.alloc(48_000).toString('base64') })
    + '\r\n\r\n' + (withDone ? 'data: {"type":"speech.audio.done",\r\ndata: "usage":{"input_tokens":100,"output_tokens":200,"total_tokens":300}}\r\n\r\n' : '');
}

test('speech stream handles split transport chunks, CRLF, and multiline event data', async () => {
  const bytes = new TextEncoder().encode(speechEvents());
  const response = new Response(new ReadableStream({ start(controller) {
    for (let n = 0; n < bytes.length; n += 137) controller.enqueue(bytes.slice(n, n + 137));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
  const result = await readSpeechStream(response);
  assert.equal(result.pcm.length, 48_000);
  assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 200, total_tokens: 300 });
  for (const raw of [speechEvents(false), 'data: {"type":"error","message":"private"}\n\n',
    'data: {"type":"speech.audio.delta","audio":"!invalid!"}\n\n']) {
    await assert.rejects(readSpeechStream(new Response(raw, { headers: { 'content-type': 'text/event-stream' } })),
      error => error instanceof Error && !error.message.includes('private'));
  }
  const missingUsage = await readSpeechStream(new Response(speechEvents().replace('"input_tokens":100', '"input_tokens":-1'),
    { headers: { 'content-type': 'text/event-stream' } }));
  assert.equal(missingUsage.usage, null);
});

test('Mini TTS persists reported usage and does not repay on resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openai-stream-'));
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only';
  let calls = 0;
  const mock: typeof fetch = async (_url, options) => {
    calls++;
    assert.equal(JSON.parse(options?.body as string).stream_format, 'sse');
    return new Response(speechEvents(), { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const streamed = { ...plan, streamFormat: 'sse' };
    const result = await runOpenaiAudition(streamed, directory, mock);
    assert.equal(result.estimatedUsageCostUsd, 0.00246);
    assert.equal(result.actualCostUsd, null);
    const resumed = await runOpenaiAudition(streamed, directory, mock);
    assert.deepEqual(resumed.actualTokenUsage, result.actualTokenUsage);
    assert.equal(calls, 1);
  } finally {
    if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old;
    await rm(directory, { recursive: true, force: true });
  }
});

test('HD reserves its character price before spending and caches successful audio', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openai-hd-'));
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only';
  const text = 'a'.repeat(1000);
  const legacy = { model: 'tts-1-hd', source: text, sourceSha256: sha(text), maxReservedUsd: 0.03,
    turns: [{ role: 'narrator', voice: 'onyx', text }] };
  let calls = 0;
  const mock: typeof fetch = async (_url, options) => {
    calls++;
    const request = JSON.parse(options?.body as string);
    assert.equal(request.model, 'tts-1-hd');
    assert.equal(request.voice, 'onyx');
    assert.equal('instructions' in request, false);
    const ledger = JSON.parse(await readFile(join(directory, 'ledger.json'), 'utf8'));
    assert.equal(ledger.charges[0].reservedUsd, 0.03);
    assert.equal(ledger.charges[0].status, 'reserved');
    return new Response(new Uint8Array(48_000), { headers: { 'x-request-id': 'test-request' } });
  };
  try {
    await assert.rejects(runOpenaiAudition({ ...legacy, maxReservedUsd: 0.02 }, directory, mock), /ceiling/);
    assert.equal(calls, 0);
    const result = await runOpenaiAudition(legacy, directory, mock);
    assert.equal(result.estimatedCharacterCostUsd, 0.03);
    assert.equal(result.actualCostUsd, null);
    assert.equal(result.duration, 1);
    await runOpenaiAudition(legacy, directory, mock);
    assert.equal(calls, 1);
  } finally {
    if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old;
    await rm(directory, { recursive: true, force: true });
  }
});

test('OpenAI billing diagnostics preserve documented causes without exposing messages', async () => {
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only';
  try {
    for (const code of ['credit_balance_exhausted', 'organization_spend_limit_exceeded',
      'project_spend_limit_exceeded', 'organization_usage_limit_exceeded', 'slow_down', 'secret-unknown-code']) {
      const directory = await mkdtemp(join(tmpdir(), 'openai-diagnostic-'));
      try {
        const mock: typeof fetch = async () => new Response(JSON.stringify({ error: { code, message: 'secret-message' } }),
          { status: 429, headers: { 'retry-after': '12' } });
        await assert.rejects(runOpenaiAudition(plan, directory, mock), /OpenAI speech HTTP 429/);
        const raw = await readFile(join(directory, 'ledger.json'), 'utf8');
        const ledger = JSON.parse(raw);
        assert.equal(ledger.charges[0].errorCode, code.startsWith('secret') ? undefined : code);
        assert.equal(ledger.charges[0].retryAfter, '12');
        assert.equal(raw.includes('secret'), false);
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
  } finally {
    if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old;
  }
});
