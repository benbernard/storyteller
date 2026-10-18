import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Asset, Segment, Config } from './schema.js';
import { Store, atomic, sha, fingerprint, commitDirectory } from './store.js';

const exec = promisify(execFile);
const SAMPLE_RATE = 44100;
export async function decode(input: string, output: string) {
  try { await exec('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', input,
    '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-y', output], { timeout: 120_000 }); }
  catch { throw new Error('Audio decode failed'); }
  const bytes = (await stat(output)).size;
  if (bytes < 2 || bytes % 2) throw new Error('Audio has no complete PCM samples');
  return { frames: bytes / 2, duration: bytes / 2 / SAMPLE_RATE };
}
export async function encode(pcm: string, output: string) {
  try { await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 's16le', '-ar', String(SAMPLE_RATE),
    '-ac', '1', '-i', pcm, '-c:a', 'libmp3lame', '-b:a', '128k', '-y', output], { timeout: 120_000 }); }
  catch { throw new Error('Chapter encoding failed'); }
}
export type RenderResult = { audio: Buffer; requestId: string | null; billedCredits: number | null };
export interface Renderer { render(segment: Segment, request: Record<string, unknown>): Promise<RenderResult> }
export class ProviderError extends Error {
  constructor(readonly status: number, readonly code?: string, provider = 'ElevenLabs') { super(`${provider} HTTP ${status}${code ? ` (${code})` : ''}`); }
}
const SAFE_PROVIDER_ERRORS = new Set(['invalid_api_key', 'missing_permissions', 'quota_exceeded',
  'detected_unusual_activity', 'voice_not_found', 'paid_plan_required', 'subscription_required',
  'insufficient_credits', 'max_character_limit_exceeded']);
export class ElevenLabs implements Renderer {
  async render(segment: Segment, request: Record<string, unknown>): Promise<RenderResult> {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error('ELEVENLABS_API_KEY is not provisioned');
    const endpoint = segment.model === 'eleven_v3' ? 'text-to-dialogue' : `text-to-speech/${encodeURIComponent(segment.turns[0]!.voice.voiceId)}`;
    const response = await fetch(`https://api.elevenlabs.io/v1/${endpoint}?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) {
      // Only known diagnostic codes may leave the provider boundary. Messages
      // can echo source text or credentials and must never be logged.
      const detail = await response.json().catch(() => null) as { detail?: { status?: unknown } } | null;
      const code = detail?.detail?.status;
      throw new ProviderError(response.status, typeof code === 'string' && SAFE_PROVIDER_ERRORS.has(code) ? code : undefined);
    }
    const billed = response.headers.get('character-cost');
    return { audio: Buffer.from(await response.arrayBuffer()), requestId: response.headers.get('request-id'),
      billedCredits: billed !== null && Number.isFinite(Number(billed)) ? Number(billed) : null };
  }
}

export type Charge = { id: string; kind: 'render' | 'rerender' | 'analysis' | 'audition'; characters: number;
  estimatedUsd: number; status: 'reserved' | 'completed' | 'failed'; model: string; chapter: number;
  asset?: string; billedCredits?: number | null; createdAt: string };
export type Ledger = { charges: Charge[] };
export class Budget {
  constructor(readonly store: Store, readonly batch: string, readonly config: Config, readonly ledger: Ledger) {}
  async save() { await this.store.write(`jobs/${this.batch}/ledger.json`, this.ledger); }
  async reserve(kind: Charge['kind'], characters: number, estimatedUsd: number, model: string, chapter: number) {
    const spent = this.ledger.charges.reduce((a, c) => ({ characters: a.characters + c.characters,
      usd: a.usd + c.estimatedUsd }), { characters: 0, usd: 0 });
    if (spent.characters + characters > this.config.budget.maxCharacters
      || spent.usd + estimatedUsd > this.config.budget.maxEstimatedUsd || this.config.budget.maxEstimatedUsd <= 0)
      throw new Error('Batch spending ceiling reached; cached audio and checkpoints are retained');
    if (kind === 'analysis' && this.ledger.charges.filter(c => c.kind === 'analysis').length >= this.config.analysis.maxCallsPerBatch)
      throw new Error('Analysis call ceiling reached');
    const charge: Charge = { id: randomUUID(), kind, characters, estimatedUsd, status: 'reserved', model, chapter,
      createdAt: new Date().toISOString() };
    this.ledger.charges.push(charge);
    // Persist the reservation before a paid request. Interrupted requests remain charged conservatively.
    await this.save();
    return charge;
  }
}

export async function cachedAsset(store: Store, key: string): Promise<Asset | undefined> {
  const asset = await store.read<Asset>(`assets/${key}/metadata.json`);
  if (!asset) return undefined;
  const audio = await readFile(store.path(`assets/${key}/audio.mp3`));
  if (asset.fingerprint !== key || sha(audio) !== asset.checksum) throw new Error('Cached audio checksum mismatch');
  return asset;
}

export async function renderSegment(store: Store, segment: Segment, config: Config, budget: Budget,
  renderer: Renderer, chapter: number, previous?: Asset, purpose: 'render' | 'rerender' | 'audition' = 'render'): Promise<Asset> {
  // Logical checkpoint pins the precise completed request, even after request IDs expire.
  const logicalPath = `cache/${segment.fingerprint}.json`;
  const pointer = await store.read<{ key: string }>(logicalPath);
  if (pointer) {
    const asset = await cachedAsset(store, pointer.key);
    if (asset) return asset;
  }
  const request = structuredClone(segment.request);
  if (segment.previousSegment && previous?.requestId
    && Date.now() - Date.parse(previous.generatedAt) < 2 * 60 * 60 * 1000) {
    request.previous_request_ids = [previous.requestId];
    delete request.previous_text;
  }
  const key = fingerprint({ logical: segment.fingerprint, request,
    neighborAudio: segment.previousSegment ? previous?.checksum ?? null : null });
  const existing = await cachedAsset(store, key);
  if (existing) { await store.write(logicalPath, { key }); return existing; }
  for (let attempt = 0; attempt < config.budget.maxAttemptsPerSegment; attempt++) {
    const charge = await budget.reserve(purpose, segment.characters,
      segment.characters / 1000 * config.budget.usdPerThousandCharacters, segment.model, chapter);
    const temporary = store.path(`assets/.pending-${randomUUID()}`);
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    try {
      const rendered = await renderer.render(segment, request);
      if (!rendered.audio.length) throw new Error('Provider returned empty audio');
      await atomic(join(temporary, 'audio.mp3'), rendered.audio);
      const decoded = await decode(join(temporary, 'audio.mp3'), join(temporary, 'check.pcm'));
      // Generous limits catch truncation/garbage without claiming semantic verification.
      if (decoded.duration < Math.max(0.1, segment.characters / 100) || decoded.duration > Math.max(30, segment.characters * 2))
        throw new Error('Audio duration outside sanity limits');
      await rm(join(temporary, 'check.pcm'));
      const asset: Asset = { schemaVersion: 1, fingerprint: key, checksum: sha(rendered.audio), ...decoded,
        requestId: rendered.requestId, generatedAt: new Date().toISOString(), billedCredits: rendered.billedCredits,
        request, model: segment.model, characters: segment.characters };
      await atomic(join(temporary, 'metadata.json'), JSON.stringify(asset, null, 2));
      await commitDirectory(temporary, store.path(`assets/${key}`));
      await store.write(logicalPath, { key });
      charge.status = 'completed'; charge.asset = key; charge.billedCredits = rendered.billedCredits;
      await budget.save();
      return asset;
    } catch (error) {
      charge.status = 'failed'; await budget.save();
      await rm(temporary, { recursive: true, force: true });
      // A network timeout has unknown billing/completion; do not silently replay it.
      if (!(error instanceof ProviderError) || ![429, 500, 502, 503, 504].includes(error.status)
        || attempt + 1 === config.budget.maxAttemptsPerSegment) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(15_000, 1000 * 2 ** attempt)));
    }
  }
  throw new Error('Render attempts exhausted');
}

export async function concatenate(store: Store, keys: string[], pauseMs: number, destination: string) {
  const pcm = destination + '.pcm';
  const { open } = await import('node:fs/promises');
  const output = await open(pcm, 'wx', 0o600);
  const parts: { frames: number; duration: number }[] = [];
  const pause = Math.round(pauseMs / 1000 * SAMPLE_RATE);
  try {
    for (const [i, key] of keys.entries()) {
      const decodedPath = destination + '.part.pcm';
      await cachedAsset(store, key);
      const part = await decode(store.path(`assets/${key}/audio.mp3`), decodedPath);
      await output.writeFile(await readFile(decodedPath));
      await rm(decodedPath);
      if (i < keys.length - 1 && pause) await output.writeFile(Buffer.alloc(pause * 2));
      parts.push(part);
    }
    await output.sync();
  } finally { await output.close(); }
  try {
    await encode(pcm, destination);
    const verification = destination + '.verify.pcm';
    const actual = await decode(destination, verification);
    await rm(verification);
    const frames = parts.reduce((n, p) => n + p.frames, 0) + pause * Math.max(0, parts.length - 1);
    if (Math.abs(actual.frames - frames) > SAMPLE_RATE / 10) throw new Error('Assembly duration mismatch');
    return { parts, duration: frames / SAMPLE_RATE, pause: pause / SAMPLE_RATE, checksum: sha(await readFile(destination)) };
  } finally { await rm(pcm, { force: true }); }
}

/** Inworld's unary API returns JSON containing base64 audio, not an audio stream. */
export class Inworld implements Renderer {
  constructor(private readonly request: typeof fetch = fetch) {}
  async render(segment: Segment, request: Record<string, unknown>): Promise<RenderResult> {
    if (!segment.model.startsWith('inworld-')) throw new Error('Inworld renderer requires an Inworld plan');
    const key = process.env.INWORLD_API_KEY;
    if (!key || /\s/.test(key)) throw new Error('INWORLD_API_KEY is not configured');
    if (typeof request.text !== 'string' || request.text.length > 2000 || request.modelId !== segment.model ||
        request.voiceId !== segment.turns[0]?.voice.voiceId) throw new Error('Invalid Inworld request');
    const response = await this.request('https://api.inworld.ai/tts/v1/voice', {
      method: 'POST', headers: { Authorization: 'Basic ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(request), redirect: 'error', signal: AbortSignal.timeout(180000),
    });
    // Error bodies may echo credentials or source text; never expose them.
    if (!response.ok) { await response.body?.cancel(); throw new ProviderError(response.status, undefined, 'Inworld'); }
    const length = Number(response.headers.get('content-length'));
    if (length > 24 * 1024 * 1024) { await response.body?.cancel(); throw new Error('Inworld response exceeds limit'); }
    const reader = response.body?.getReader(); if (!reader) throw new Error('Inworld returned empty response');
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length;
      if (size > 24 * 1024 * 1024) throw new Error('Inworld response exceeds limit'); chunks.push(part.value); }
    } finally { await reader.cancel(); }
    let payload: { audioContent?: unknown; usage?: { modelId?: unknown; processedCharactersCount?: unknown } };
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof payload; }
    catch { throw new Error('Inworld returned invalid JSON'); }
    if (!payload || typeof payload.audioContent !== 'string' || !payload.audioContent.length ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.audioContent) || payload.audioContent.length % 4 !== 0)
      throw new Error('Inworld returned invalid base64 audio');
    if (payload.usage?.modelId && payload.usage.modelId !== segment.model) throw new Error('Inworld response model differs from request');
    const reported = payload.usage?.processedCharactersCount;
    if (reported !== undefined && (typeof reported !== 'number' || !Number.isSafeInteger(reported) || reported < 0)) throw new Error('Invalid Inworld usage');
    const audio = Buffer.from(payload.audioContent, 'base64');
    if (!audio.length || audio.length > 16 * 1024 * 1024) throw new Error('Inworld audio exceeds limit');
    return { audio, billedCredits: typeof reported === 'number' ? reported : null, requestId: response.headers.get('x-request-id') ?? response.headers.get('request-id') };
  }
}
export class SpeechProviders implements Renderer {
  constructor(private readonly eleven: Renderer = new ElevenLabs(), private readonly inworld: Renderer = new Inworld()) {}
  render(segment: Segment, request: Record<string, unknown>): Promise<RenderResult> {
    return (segment.model.startsWith('inworld-') ? this.inworld : this.eleven).render(segment, request);
  }
}
