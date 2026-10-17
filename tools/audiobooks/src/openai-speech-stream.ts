import { z } from 'zod';

const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
}).refine(u => u.input_tokens + u.output_tokens === u.total_tokens);
export type SpeechUsage = z.infer<typeof usageSchema>;

// Auditions permit at most two minutes of mono 24 kHz PCM per request.
// Bound the encoded response as well as the decoded audio; never log event bodies.
export async function readSpeechStream(response: Response): Promise<{ pcm: Buffer; usage: SpeechUsage | null }> {
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body)
    throw new Error('Expected OpenAI speech event stream');
  const reader = response.body.getReader();
  const encoded: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 10_000_000) throw new Error('OpenAI speech stream exceeds audition limit');
      encoded.push(chunk.value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error('OpenAI speech stream interrupted or oversized; no automatic retry');
  } finally { reader.releaseLock(); }
  const chunks: Buffer[] = [];
  let done = false;
  let usage: SpeechUsage | null = null;
  for (const frame of Buffer.concat(encoded).toString('utf8').replace(/\r\n/g, '\n').split('\n\n')) {
    const data = frame.split('\n').filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') continue;
    let event: { type?: unknown; audio?: unknown; usage?: unknown };
    try { event = JSON.parse(data); }
    catch { throw new Error('Invalid OpenAI speech event'); }
    if (!event || typeof event !== 'object' || done) throw new Error('Invalid OpenAI speech event order');
    if (event.type === 'speech.audio.delta') {
      if (typeof event.audio !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.audio))
        throw new Error('Invalid OpenAI speech audio encoding');
      chunks.push(Buffer.from(event.audio, 'base64'));
    } else if (event.type === 'speech.audio.done') {
      done = true;
      const parsed = usageSchema.safeParse(event.usage);
      usage = parsed.success ? parsed.data : null;
    } else { throw new Error('Unexpected OpenAI speech event'); }
  }
  if (!done || chunks.length === 0) throw new Error('Incomplete OpenAI speech stream; no automatic retry');
  return { pcm: Buffer.concat(chunks), usage };
}
