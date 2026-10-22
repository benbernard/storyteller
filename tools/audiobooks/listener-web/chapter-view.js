/* A view of an immutable recording. Saved locations always use source seconds. */
class ChapterView {
  constructor(duration, ranges = []) {
    this.sourceDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    this.removed = [];
    for (const range of ranges.filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.start >= 0 && r.start < this.sourceDuration && r.end > r.start && r.end <= this.sourceDuration + .100001).sort((a, b) => a.start - b.start)) {
      const end = Math.min(range.end, this.sourceDuration), last = this.removed.at(-1);
      if (last && range.start <= last.end) last.end = Math.max(last.end, end);
      else this.removed.push({ start: range.start, end });
    }
    this.duration = this.sourceDuration - this.removed.reduce((sum, r) => sum + r.end - r.start, 0);
  }
  position(source) {
    const seconds = Math.max(0, Math.min(this.sourceDuration, source));
    return seconds - this.removed.reduce((sum, r) => sum + Math.max(0, Math.min(seconds, r.end) - r.start), 0);
  }
  source(position) {
    const seconds = Math.max(0, Math.min(this.duration, position));
    if (seconds >= this.duration) return this.sourceDuration;
    let offset = 0;
    for (const r of this.removed) {
      if (seconds < r.start - offset) break;
      offset += r.end - r.start;
    }
    return Math.min(this.sourceDuration, seconds + offset);
  }
  undoPosition(source, passages = []) {
    const range = this.removed.find(r => source >= r.start && source < r.end);
    if (!range) return Math.max(0, Math.min(this.sourceDuration, source));
    const previous = passages.filter(p => p.sectionKind !== 'author-note' && p.end <= range.start).at(-1);
    if (previous) return previous.start;
    if (range.start > 0) return this.removed.filter(r => r.end <= range.start).at(-1)?.end || 0;
    return this.source(this.position(source));
  }
  static ranges(reading, duration) {
    const passages = reading?.passages || [];
    return passages.filter(p => p.sectionKind === 'author-note').map(p => {
      const index = passages.indexOf(p), next = passages[index + 1]?.start ?? duration;
      return { start: p.start, end: next >= p.end && next - p.end <= .100001 ? next : p.end };
    });
  }
  static paragraphs(passages, includeAuthorNotes = true) {
    const visible = [], ranges = [], paragraphs = [];
    let text = '';
    for (const passage of passages) {
      if (!includeAuthorNotes && passage.sectionKind === 'author-note') { text += '\n\n'; continue; }
      const index = visible.length, start = text.length;
      visible.push(passage); text += passage.text;
      ranges.push({ index, start, end: text.length });
    }
    // Recording segments can divide either words or the blank line between paragraphs.
    // Find paragraph boundaries in the joined source, retaining each fragment's seek target.
    let start = 0, firstRange = 0;
    const append = end => {
      if (!text.slice(start, end).trim()) return;
      while (firstRange < ranges.length && ranges[firstRange].end <= start) firstRange++;
      const fragments = [];
      for (let i = firstRange; i < ranges.length && ranges[i].start < end; i++) {
        const range = ranges[i], fragment = text.slice(Math.max(start, range.start), Math.min(end, range.end));
        if (fragment) fragments.push({ index: range.index, text: fragment });
      }
      if (fragments.length) paragraphs.push(fragments);
    };
    for (const boundary of text.matchAll(/\n\s*\n/g)) { append(boundary.index); start = boundary.index + boundary[0].length; }
    append(text.length);
    return { passages: visible, paragraphs };
  }
}
globalThis.ChapterView = ChapterView;
