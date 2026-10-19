package com.crabanddog.listener

data class AudioRange(val start: Double, val end: Double)

/** Public clocks omit notes; all stored locations retain their source coordinate. */
class ChapterView(val sourceDuration: Double, ranges: List<AudioRange> = emptyList()) {
    val removed: List<AudioRange>
    val duration: Double
    init {
        val result = mutableListOf<AudioRange>()
        ranges.filter { it.start.isFinite() && it.end.isFinite() && it.start >= 0 && it.start < sourceDuration && it.end > it.start && it.end <= sourceDuration + .100001 }
            .sortedBy { it.start }.forEach { range ->
                val end = range.end.coerceAtMost(sourceDuration)
                val last = result.lastOrNull()
                if (last != null && range.start <= last.end) result[result.lastIndex] = last.copy(end = maxOf(last.end, end))
                else result.add(range.copy(end = end))
            }
        removed = result
        duration = sourceDuration - result.sumOf { it.end - it.start }
    }
    fun position(source: Double): Double {
        val seconds = source.coerceIn(0.0, sourceDuration)
        return seconds - removed.sumOf { (minOf(seconds, it.end) - it.start).coerceAtLeast(0.0) }
    }
    fun source(position: Double): Double {
        val seconds = position.coerceIn(0.0, duration)
        if (seconds >= duration) return sourceDuration
        var offset = 0.0
        for (range in removed) {
            if (seconds < range.start - offset) break
            offset += range.end - range.start
        }
        return (seconds + offset).coerceAtMost(sourceDuration)
    }
}

fun noteRanges(reading: Reading?, duration: Double): List<AudioRange> = reading?.passages.orEmpty().mapIndexedNotNull { index, p ->
    if (p.sectionKind != "author-note") return@mapIndexedNotNull null
    val next = reading?.passages?.getOrNull(index + 1)?.start ?: duration
    AudioRange(p.start, if (next >= p.end && next - p.end <= .100001) next else p.end)
}

fun chapterView(chapter: Chapter, reading: Reading? = null, includeNotes: Boolean = true): ChapterView = ChapterView(chapter.duration,
    if (includeNotes) emptyList() else if (reading?.assembly == chapter.assembly) noteRanges(reading, chapter.duration) else chapter.authorNoteRanges.orEmpty())

/** A legacy Undo anchor in a hidden note returns to the preceding readable passage. */
fun undoPosition(chapter: Chapter, reading: Reading?, includeNotes: Boolean, seconds: Double): Double {
    val view = chapterView(chapter, reading, includeNotes)
    val range = view.removed.firstOrNull { seconds >= it.start && seconds < it.end } ?: return seconds.coerceIn(0.0, chapter.duration)
    val previous = reading?.takeIf { it.assembly == chapter.assembly }?.passages?.lastOrNull { it.sectionKind != "author-note" && it.end <= range.start }
    if (previous != null) return previous.start
    if (range.start > 0) return view.removed.lastOrNull { it.end <= range.start }?.end ?: 0.0
    return view.source(view.position(seconds))
}
