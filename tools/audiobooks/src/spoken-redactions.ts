/** A versioned spoken view of visual redactions; canonical source stays intact. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { fingerprint, sha } from './store.js';

export const visualRedactionPolicy = 'visual-full-block-redactions-v1' as const;
const rangeSchema = z.object({ kind: z.enum(['copy', 'redaction']), sourceStart: z.number().int().nonnegative(), sourceEnd: z.number().int().positive(),
  spokenStart: z.number().int().nonnegative(), spokenEnd: z.number().int().positive() }).strict();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const renderingSchema = z.object({ policy: z.literal(visualRedactionPolicy), sourceHash: hashSchema, spokenHash: hashSchema,
  text: z.string(), mapping: z.array(rangeSchema), fingerprint: hashSchema }).strict();
export type SpokenRedactionRange = z.infer<typeof rangeSchema>;
export type SpokenRedactionRendering = z.infer<typeof renderingSchema>;
type RenderingContent = Omit<SpokenRedactionRendering, 'fingerprint'>;

function replacement(source: string, start: number, end: number): string {
  // Do not turn a hidden component into an apparent visible word. Two UTF-16
  // code units are enough to inspect an adjacent astral letter or number.
  const before = /[\p{L}\p{N}]$/u.test(source.slice(Math.max(0, start - 2), start));
  const after = /^[\p{L}\p{N}]/u.test(source.slice(end, end + 2));
  return `${before ? ' ' : ''}redacted${after ? ' ' : ''}`;
}
export function renderVisualRedactions(source: string): SpokenRedactionRendering {
  const mapping: SpokenRedactionRange[] = [], pieces: string[] = [];
  let sourceOffset = 0, spokenOffset = 0;
  const append = (kind: SpokenRedactionRange['kind'], start: number, end: number, text: string): void => {
    if (end <= start) return;
    mapping.push({ kind, sourceStart: start, sourceEnd: end, spokenStart: spokenOffset, spokenEnd: spokenOffset + text.length });
    pieces.push(text); spokenOffset += text.length;
  };
  // A solitary block may be a symbol. This policy changes only explicit runs
  // of at least two FULL BLOCK characters, not names, missing text or shades.
  for (const match of source.matchAll(/\u2588{2,}/gu)) {
    const start = match.index, end = start + match[0].length;
    append('copy', sourceOffset, start, source.slice(sourceOffset, start));
    append('redaction', start, end, replacement(source, start, end));
    sourceOffset = end;
  }
  append('copy', sourceOffset, source.length, source.slice(sourceOffset));
  const text = pieces.join('');
  const content: RenderingContent = { policy: visualRedactionPolicy, sourceHash: sha(source), spokenHash: sha(text), text, mapping };
  return { ...content, fingerprint: fingerprint(content) };
}
/** Verify the complete map, not merely the presence of a matching policy label. */
export function verifyVisualRedactions(source: string, value: unknown): SpokenRedactionRendering {
  const parsed = renderingSchema.parse(value), expected = renderVisualRedactions(source);
  if (fingerprint(parsed) !== fingerprint(expected)) throw Error('Spoken redaction rendering differs from the exact source and policy');
  return parsed;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  // The CLI consumes JSON strings, never shell arguments containing book text.
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) { input += String(chunk); if (input.length > 4_000_000) throw Error('Source input exceeds the renderer limit'); }
  const source: unknown = JSON.parse(input);
  if (typeof source !== 'string') throw Error('Expected a JSON source string on stdin');
  console.log(JSON.stringify(renderVisualRedactions(source)));
}
