/** Literal spoken view of stylistic combining overlays; never restores text. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { fingerprint, sha } from './store.js';

export const combiningOverlayPolicy = 'combining-overlay-v1' as const;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const rangeSchema = z.object({ kind: z.enum(['copy', 'overlay']),
  sourceStart: z.number().int().nonnegative(), sourceEnd: z.number().int().positive(),
  spokenStart: z.number().int().nonnegative(), spokenEnd: z.number().int().nonnegative() }).strict();
const renderingSchema = z.object({ policy: z.literal(combiningOverlayPolicy), sourceHash: hashSchema,
  spokenHash: hashSchema, text: z.string(), mapping: z.array(rangeSchema), fingerprint: hashSchema }).strict();
export type SpokenOverlayRange = z.infer<typeof rangeSchema>;
export type SpokenOverlayRendering = z.infer<typeof renderingSchema>;

/** All offsets are UTF-16 code units; fingerprints use store.canonical SHA256. */
export function renderCombiningOverlays(source: string): SpokenOverlayRendering {
  const mapping: SpokenOverlayRange[] = [], pieces: string[] = [];
  let cursor = 0, spokenOffset = 0;
  const append = (kind: SpokenOverlayRange['kind'], start: number, end: number, text: string): void => {
    if (end <= start) return;
    mapping.push({ kind, sourceStart: start, sourceEnd: end, spokenStart: spokenOffset, spokenEnd: spokenOffset + text.length });
    pieces.push(text); spokenOffset += text.length;
  };
  // Remove exactly these five stylistic overlay marks even when they adorn
  // spaces/punctuation or cross a child boundary. Every other source unit,
  // including accents, visible letters, blocks and semantic '+', stays exact.
  for (const match of source.matchAll(/[\u0334-\u0338]+/gu)) {
    const start = match.index, end = start + match[0].length;
    append('copy', cursor, start, source.slice(cursor, start));
    append('overlay', start, end, '');
    cursor = end;
  }
  append('copy', cursor, source.length, source.slice(cursor));
  const text = pieces.join('');
  const content = { policy: combiningOverlayPolicy, sourceHash: sha(source), spokenHash: sha(text), text, mapping };
  return { ...content, fingerprint: fingerprint(content) };
}

export function verifyCombiningOverlays(source: string, value: unknown): SpokenOverlayRendering {
  const parsed = renderingSchema.parse(value), expected = renderCombiningOverlays(source);
  if (fingerprint(parsed) !== fingerprint(expected)) throw Error('Spoken overlay rendering differs from the exact source and policy');
  return parsed;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) { input += String(chunk); if (input.length > 4_000_000) throw Error('Source input exceeds the renderer limit'); }
  const source: unknown = JSON.parse(input);
  if (typeof source !== 'string') throw Error('Expected a JSON source string on stdin');
  console.log(JSON.stringify(renderCombiningOverlays(source)));
}
