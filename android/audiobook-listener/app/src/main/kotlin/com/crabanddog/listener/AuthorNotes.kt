package com.crabanddog.listener

fun needsSectionRefresh(reading: Reading?): Boolean = reading == null || reading.sectionMetadataVersion < 1

/** Absolute audio positions remain unchanged. Unknown and malformed ranges play normally. */
fun authorNoteEnd(reading: Reading?, seconds: Double, duration: Double): Double? {
    if (!seconds.isFinite() || !duration.isFinite() || duration <= 0.0) return null
    val notes = authorNoteRanges(reading, duration)
    var target = seconds
    for (note in notes) {
        if (note.start <= target && target < note.end) target = note.end
    }
    // Assemblies can end with a 100ms join pause outside all passage ranges.
    // Never consume ordinary/unknown content that occupies that small tail.
    if (target > seconds && duration - target <= 0.100001 && reading?.passages.orEmpty().none {
            it.sectionKind != "author-note" && it.start < duration && it.end > target
        }) target = duration
    return target.takeIf { it > seconds }
}

internal fun authorNoteRanges(reading: Reading?, duration: Double): List<Passage> = reading?.passages.orEmpty().filter {
    it.sectionKind == "author-note" && it.start.isFinite() && it.end.isFinite() &&
        it.start >= 0.0 && it.end > it.start && it.end <= duration
}.sortedBy { it.start }
