import { openAIConnection } from './openai-connection.js';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { Store, atomic, fingerprint, sha } from './store.js';
import { readSpeechStream, type SpeechUsage } from './openai-speech-stream.js';

const voices = z.enum(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);
const legacyVoices = new Set(['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer']);
export const openaiAuditionSchema = z.object({
  model: z.enum(['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']),
  streamFormat: z.enum(['audio', 'sse']).optional(),
  source: z.string().min(1).max(2000),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  maxReservedUsd: z.number().positive().max(0.25),
  turns: z.array(z.object({
    role: z.string().min(1).max(40), voice: voices,
    text: z.string().min(1).max(1000).refine(t => t.trim().length > 0),
    instructions: z.string().min(1).max(700).optional(),
    pauseAfterMs: z.number().int().min(0).max(1000).default(100),
  }).strict()).min(1).max(12),
}).strict().superRefine((input, ctx) => {
  if (input.streamFormat === 'sse' && input.model !== 'gpt-4o-mini-tts')
    ctx.addIssue({ code: 'custom', path: ['streamFormat'], message: 'Only Mini TTS supports speech event streams' });
  if (input.turns.map(t => t.text).join('') !== input.source || sha(input.source) !== input.sourceSha256)
    ctx.addIssue({ code: 'custom', message: 'Source checksum or exact turn coverage mismatch' });
  for (const [index, turn] of input.turns.entries()) {
    if (input.model === 'gpt-4o-mini-tts' && !turn.instructions)
      ctx.addIssue({ code: 'custom', path: ['turns', index, 'instructions'], message: 'Mini TTS auditions require acting instructions' });
    if (input.model !== 'gpt-4o-mini-tts' && (!legacyVoices.has(turn.voice) || turn.instructions !== undefined))
      ctx.addIssue({ code: 'custom', path: ['turns', index], message: 'TTS-1 models require a supported voice and no acting instructions' });
  }
});
type Charge = { turn: number; reservedUsd: number; status: 'reserved' | 'completed';
  usage?: SpeechUsage | null;
  requestId?: string | null; checksum?: string; duration?: number; httpStatus?: number; errorCode?: string; retryAfter?: string };
const RESERVATION = 0.02; // Deliberately generous for each <=1000-character audition turn.
export function reservationAllowed(charges: Charge[], maximum: number, nextReservation = RESERVATION) {
  return charges.reduce((sum, c) => sum + c.reservedUsd, 0) + nextReservation <= maximum + 1e-9;
}

export async function runOpenaiAudition(input: unknown, destination: string, request: typeof fetch = fetch) {
  const plan = openaiAuditionSchema.parse(input);
  const connection = openAIConnection('api');
  const store = new Store(destination);
  return store.lock(async () => {
    const identity = fingerprint(plan);
    const previous = await store.read<{ identity: string; charges: Charge[] }>('ledger.json');
    if (previous && previous.identity !== identity) throw new Error('Output directory contains a different audition');
    const ledger = previous ?? { identity, charges: [] as Charge[] };
    await store.write('plan.json', plan);
    const chunks: Buffer[] = [];
    for (const [index, turn] of plan.turns.entries()) {
      const file = store.path(`turn-${index}.pcm`);
      let charge = ledger.charges.find(c => c.turn === index);
      let pcm: Buffer;
      if (charge) {
        if (charge.status !== 'completed') throw new Error('Uncertain previous request; refusing paid replay');
        pcm = await readFile(file);
        if (sha(pcm) !== charge.checksum) throw new Error('Cached turn checksum mismatch');
      } else {
        const reservedUsd = plan.model === 'gpt-4o-mini-tts' ? RESERVATION
          : turn.text.length * (plan.model === 'tts-1-hd' ? 30 : 15) / 1_000_000;
        if (!reservationAllowed(ledger.charges, plan.maxReservedUsd, reservedUsd)) throw new Error('Audition reservation ceiling reached');
        charge = { turn: index, reservedUsd, status: 'reserved' };
        ledger.charges.push(charge);
        await store.write('ledger.json', ledger); // Durable before any paid call; failures stay reserved.
        let response: Response;
        try {
          response = await request(connection.base+'/audio/speech', {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
            headers: { ...connection.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: plan.model, voice: turn.voice, input: turn.text,
              instructions: turn.instructions, response_format: 'pcm', speed: 1, stream_format: plan.streamFormat }),
          });
        } catch { throw new Error('OpenAI speech transport failed; no automatic retry'); }
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: { code?: unknown } } | null;
          const code = body?.error?.code;
          const safe = ['invalid_api_key', 'insufficient_quota', 'rate_limit_exceeded', 'model_not_found',
            'billing_hard_limit_reached', 'usage_limit_reached', 'credit_balance_exhausted',
            'organization_spend_limit_exceeded', 'project_spend_limit_exceeded',
            'organization_usage_limit_exceeded', 'slow_down', 'server_is_overloaded'];
          charge.httpStatus = response.status;
          if (typeof code === 'string' && safe.includes(code)) charge.errorCode = code;
          const retryAfter = response.headers.get('retry-after');
          if (retryAfter && /^[0-9]{1,8}$/.test(retryAfter)) charge.retryAfter = retryAfter;
          await store.write('ledger.json', ledger);
          throw new Error(`OpenAI speech HTTP ${response.status}${typeof code === 'string' && safe.includes(code) ? ` (${code})` : ''}`);
        }
        if (plan.streamFormat === 'sse') {
          const streamed = await readSpeechStream(response);
          pcm = streamed.pcm;
          charge.usage = streamed.usage;
        } else { pcm = Buffer.from(await response.arrayBuffer()); }
        if (!pcm.length || pcm.length % 2 || pcm.length > 24_000 * 2 * 120)
          throw new Error('Invalid PCM size');
        await atomic(file, pcm);
        Object.assign(charge, { status: 'completed', requestId: response.headers.get('x-request-id'),
          checksum: sha(pcm), duration: pcm.length / 48_000 });
        await store.write('ledger.json', ledger);
        console.log(JSON.stringify({ turn: index + 1, role: turn.role, seconds: charge.duration }));
      }
      chunks.push(pcm);
      if (index < plan.turns.length - 1) chunks.push(Buffer.alloc(Math.round(turn.pauseAfterMs * 48)));
    }
    const joined = Buffer.concat(chunks);
    await atomic(store.path('scene.pcm'), joined);
    try {
      execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1',
        '-i', store.path('scene.pcm'), '-c:a', 'libmp3lame', '-b:a', '128k', '-y', store.path('openai-scene.mp3')]);
      execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', store.path('openai-scene.mp3'), '-f', 'null', '-']);
    } catch { throw new Error('Audio assembly or decode verification failed'); }
    const usage = ledger.charges.every(c => c.usage) ? ledger.charges.reduce((sum, c) => ({
      input_tokens: sum.input_tokens + c.usage!.input_tokens,
      output_tokens: sum.output_tokens + c.usage!.output_tokens,
      total_tokens: sum.total_tokens + c.usage!.total_tokens,
    }), { input_tokens: 0, output_tokens: 0, total_tokens: 0 }) : null;
    const result = { model: plan.model, sourceSha256: plan.sourceSha256, sourceCharacters: plan.source.length,
      exactInputCoverage: true, voices: Object.fromEntries(plan.turns.map(t => [t.role, t.voice])),
      duration: joined.length / 48_000, generatedSeconds: ledger.charges.reduce((n, c) => n + (c.duration ?? 0), 0),
      reservedUsd: ledger.charges.reduce((n, c) => n + c.reservedUsd, 0),
      actualTokenUsage: usage, actualCostUsd: null,
      estimatedUsageCostUsd: usage ? (usage.input_tokens * 0.6 + usage.output_tokens * 12) / 1_000_000 : null,
      estimatedCharacterCostUsd: plan.model === 'gpt-4o-mini-tts' ? null
        : plan.source.length * (plan.model === 'tts-1-hd' ? 30 : 15) / 1_000_000,
      usageNote: usage ? 'Provider-reported tokens priced at $0.60/M text input and $12/M audio output; reconcile invoice separately.'
        : 'Token usage unavailable for one or more turns. Reconcile actual billing in the provider account.',
      checksum: sha(await readFile(store.path('openai-scene.mp3'))), requestCount: ledger.charges.length };
    await store.write('results.json', result);
    return result;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node dist/openai-audition.js PLAN_JSON OUTPUT_DIRECTORY');
  await mkdir(output, { recursive: true, mode: 0o700 });
  console.log(JSON.stringify(await runOpenaiAudition(JSON.parse(await readFile(input, 'utf8')), output)));
}
