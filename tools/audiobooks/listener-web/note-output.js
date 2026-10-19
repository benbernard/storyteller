/* Audio-clock automation stays active when page timers are delayed or throttled. */
class NoteOutputGuard {
  constructor(audio) {
    this.audio = audio;
    this.context = new (window.AudioContext || window.webkitAudioContext)();
    this.gain = this.context.createGain();
    this.source = this.context.createMediaElementSource(audio);
    this.source.connect(this.gain).connect(this.context.destination);
  }
  resume() { return this.context.resume(); }
  update(reading, excluded, gated) {
    const now = this.context.currentTime, param = this.gain.gain, position = this.audio.currentTime, rate = this.audio.playbackRate;
    param.cancelScheduledValues(now);
    if (!excluded) { param.setValueAtTime(1, now); return; }
    if (gated || this.audio.seeking) { param.setValueAtTime(0, now); return; }
    const passages = reading?.passages || [];
    const ranges = passages.filter(p => p.sectionKind === 'author-note' && Number.isFinite(p.start) && Number.isFinite(p.end) && p.start >= 0 && p.end > p.start && p.end <= this.audio.duration + .1)
      .map(p => {
        // Published join pauses are outside passage ranges. Use only a verified
        // preceding gap, never a fixed early cutoff into the chapter's words.
        const previousEnd = Math.max(0, ...passages.filter(q => Number.isFinite(q.end) && q.end <= p.start).map(q => q.end));
        return {start: p.start - previousEnd <= .100001 ? previousEnd : p.start, end: p.end};
      }).sort((a, b) => a.start - b.start);
    const merged = [];
    for (const range of ranges) {
      if (merged.length && range.start <= merged.at(-1).end) merged.at(-1).end = Math.max(merged.at(-1).end, range.end);
      else merged.push({...range});
    }
    param.setValueAtTime(merged.some(r => r.start <= position && position < r.end) ? 0 : 1, now);
    if (this.audio.paused || !Number.isFinite(rate) || rate <= 0) return;
    for (const range of merged) {
      if (range.start > position) param.setValueAtTime(0, now + (range.start - position) / rate);
      if (range.end > position) param.setValueAtTime(1, now + (range.end - position) / rate);
    }
  }
}
