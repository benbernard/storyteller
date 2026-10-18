/** Explicit, source-bound numeric notation view. Never rewrites an operand. */
import { z } from 'zod';
import { fingerprint, sha } from './store.js';

export const sourceNotationPolicy = 'source-numeric-notation-v1' as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const range = z.object({ kind: z.enum(['copy', 'comparison', 'celsius', 'literal-unit']),
  sourceStart: z.number().int().nonnegative(), sourceEnd: z.number().int().positive(),
  spokenStart: z.number().int().nonnegative(), spokenEnd: z.number().int().positive() }).strict();
const schema = z.object({ policy: z.literal(sourceNotationPolicy), sourceHash: digest, spokenHash: digest,
  text: z.string(), literalUnitOffsets: z.array(z.number().int().nonnegative()), mapping: z.array(range), fingerprint: digest }).strict();
export type SourceNotationRendering = z.infer<typeof schema>;
const letterNames: Readonly<Record<string, string>> = {
  a: 'ay', b: 'bee', c: 'see', d: 'dee', e: 'ee', f: 'ef', g: 'jee', h: 'aitch', i: 'eye', j: 'jay',
  k: 'kay', l: 'el', m: 'em', n: 'en', o: 'oh', p: 'pee', q: 'cue', r: 'ar', s: 'ess', t: 'tee',
  u: 'you', v: 'vee', w: 'double you', x: 'ex', y: 'why', z: 'zee',
};

export function literalCompoundUnit(source: string): string {
  if (!/^[a-z]{4}\/[a-z]{3}$/u.test(source)) throw Error('Literal unit requires exactly four lowercase ASCII letters, slash, three lowercase ASCII letters');
  return source.split('/').map(side => 'lowercase ' + [...side].map(letter => letterNames[letter]!).join(' ')).join(' slash ');
}

/** Canonical eligibility is deliberately narrower than the comparison checker. */
export function numericComparatorOffsets(source: string): number[] {
  return [...source.matchAll(/</gu)].map(match => {
    const quantity = /^<\s*\d+(?:\.\d+)?(?:%|[A-Za-z]{1,16})?(?=$|[\s,;:.!?)\]])/u.exec(source.slice(match.index));
    if (!quantity || /[<>=]/u.test(source[match.index - 1] ?? '') || /^\.\d/u.test(source.slice(match.index + quantity[0].length))) {
      throw Error('Unsupported canonical less-than expression');
    }
    return match.index;
  });
}

/** Literal unit offsets require a separately reviewed canonical/queued binding. */
export function renderSourceNotation(source: string, literalUnitOffsets: readonly number[] = []): SourceNotationRendering {
  const edits = [...source.matchAll(/<|°C\b/gu)].map(match => ({ start: match.index, end: match.index + match[0].length,
    kind: match[0] === '<' ? 'comparison' as const : 'celsius' as const, text: match[0] === '<' ? 'less than' : 'degrees Celsius' }));
  const ordered = [...literalUnitOffsets].sort((a, b) => a - b);
  if (ordered.some((offset, index) => !Number.isInteger(offset) || offset < 0 || offset !== literalUnitOffsets[index]
      || offset === ordered[index - 1] || offset + 8 > source.length)) throw Error('Literal unit offsets must be unique, ordered and in bounds');
  const changes: { start: number; end: number; kind: 'comparison' | 'celsius' | 'literal-unit'; text: string }[] = [...edits];
  for (const offset of ordered) {
    if (/[\p{L}\p{N}\p{M}_]$/u.test(source.slice(0, offset)) || /^[\p{L}\p{N}\p{M}_]/u.test(source.slice(offset + 8))) throw Error('Literal unit must be a complete token');
    changes.push({ start: offset, end: offset + 8, kind: 'literal-unit', text: literalCompoundUnit(source.slice(offset, offset + 8)) });
  }
  changes.sort((a, b) => a.start - b.start);
  const mapping: SourceNotationRendering['mapping'] = [], pieces: string[] = [];
  let cursor = 0, spokenOffset = 0;
  const append = (kind: SourceNotationRendering['mapping'][number]['kind'], start: number, end: number, text: string): void => {
    if (end <= start) return;
    mapping.push({ kind, sourceStart: start, sourceEnd: end, spokenStart: spokenOffset, spokenEnd: spokenOffset + text.length });
    pieces.push(text); spokenOffset += text.length;
  };
  for (const change of changes) {
    if (change.start < cursor) throw Error('Notation ranges overlap');
    append('copy', cursor, change.start, source.slice(cursor, change.start));
    const before = /[\p{L}\p{N}]$/u.test(source.slice(Math.max(0, change.start - 2), change.start));
    const after = /^[\p{L}\p{N}]/u.test(source.slice(change.end, change.end + 2));
    append(change.kind, change.start, change.end, `${before ? ' ' : ''}${change.text}${after ? ' ' : ''}`);
    cursor = change.end;
  }
  append('copy', cursor, source.length, source.slice(cursor));
  const text = pieces.join(''), content = { policy: sourceNotationPolicy, sourceHash: sha(source), spokenHash: sha(text),
    text, literalUnitOffsets: ordered, mapping };
  return { ...content, fingerprint: fingerprint(content) };
}

export function verifySourceNotation(source: string, literalUnitOffsets: readonly number[], value: unknown): SourceNotationRendering {
  const parsed = schema.parse(value), expected = renderSourceNotation(source, literalUnitOffsets);
  if (fingerprint(parsed) !== fingerprint(expected)) throw Error('Notation rendering differs from exact source, reviewed offsets and policy');
  return parsed;
}
