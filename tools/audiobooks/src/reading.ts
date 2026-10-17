import { type Assembly, type Chapter, type Analysis } from './schema.js';
import { type BookChapter } from './book.js';
import { Store, sha } from './store.js';

export type Passage = { id: string; start: number; end: number; text: string; startOffset: number; endOffset: number; speakers: string[]; spans: string[] };
export type Reading = { assembly: string; source: string; chapterId: string; title: string; url: string; duration: number; text: string; passages: Passage[] };

export async function reading(store: Store, assembly: Assembly, chapter: BookChapter): Promise<Reading> {
  const source = await store.read<Chapter>(`sources/${assembly.source}.json`);
  if (!source || sha(source.text) !== source.contentHash) throw new Error('Source integrity failure');
  const analysis = await store.read<Analysis>(`analyses/${assembly.analysis}.json`);
  let offset = 0, end = 0;
  const passages = assembly.timeline.map(segment => {
    if (!Number.isFinite(segment.start) || segment.start < end || segment.end < segment.start || segment.end > assembly.duration + .1) throw new Error('Timeline integrity failure');
    end = segment.end;
    const startOffset = offset;
    if (segment.presentation && segment.spans.length) throw new Error('Presentation must not claim body offsets');
    const text = segment.spans.map(span => {
      if (span.start !== offset || span.end < span.start || span.end > source.text.length) throw new Error('Source span integrity failure');
      offset = span.end;
      return source.text.slice(span.start, span.end);
    }).join('');
    return { id: segment.segmentId, start: segment.start, end: segment.end, text: segment.presentation?.text ?? text, startOffset, endOffset: offset,
      spans: segment.spans.map(s => s.uid), speakers: segment.presentation ? [segment.presentation.speaker] : [...new Set(segment.spans.map(s => analysis?.spans.find(a => a.uid === s.uid)?.speaker).filter((s): s is string => !!s))] };
  });
  if (offset !== source.text.length || passages.filter((_, i) => !assembly.timeline[i]!.presentation).map(p => p.text).join('') !== source.text) throw new Error('Incomplete source timeline');
  return { assembly: assembly.id, source: assembly.source, chapterId: chapter.id, title: chapter.title, url: source.url, duration: assembly.duration, text: source.text, passages };
}

// A join pause belongs to the preceding passage; the next highlights at its actual start.
export function passageAt<T extends { start: number }>(passages: T[], seconds: number): T | undefined {
  let lo = 0, hi = passages.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (passages[mid]!.start <= seconds) lo = mid + 1; else hi = mid; }
  return passages[Math.max(0, lo - 1)];
}
