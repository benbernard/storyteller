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
}
globalThis.ChapterView = ChapterView;
