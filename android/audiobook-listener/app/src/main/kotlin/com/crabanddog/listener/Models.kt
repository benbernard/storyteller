package com.crabanddog.listener

import org.json.JSONObject

data class Chapter(val id: String, val sequence: Int, val title: String, val assembly: String, val duration: Double, val checksum: String = "", val authorNoteRanges: List<AudioRange>? = null)
data class Book(val id: String, val title: String, val author: String, val editions: Map<String, List<Chapter>>, val autoDownload: Boolean = false, val defaultEdition: String = editions.keys.firstOrNull().orEmpty())
data class Selection(val story: String, val bookTitle: String, val edition: String, val chapter: Chapter) {
    val key get() = "$story:$edition:${chapter.id}"
    fun json() = JSONObject().put("story", story).put("bookTitle", bookTitle).put("edition", edition)
        .put("chapter", JSONObject().put("id", chapter.id).put("sequence", chapter.sequence).put("title", chapter.title).put("assembly", chapter.assembly).put("duration", chapter.duration).put("checksum", chapter.checksum).apply {
            chapter.authorNoteRanges?.let { ranges -> put("authorNoteRanges", org.json.JSONArray().apply { ranges.forEach { put(JSONObject().put("start", it.start).put("end", it.end)) } }) }
        })
    fun location(seconds: Double) = JSONObject().put("story", story).put("edition", edition).put("assembly", chapter.assembly).put("seconds", seconds.coerceIn(0.0, chapter.duration))
}
fun chapterFromJson(j: JSONObject) = Chapter(j.getString("id"), j.getInt("sequence"), j.getString("title"), j.getString("assembly"), j.getDouble("duration"), j.optString("checksum"), j.optJSONArray("authorNoteRanges")?.let { a -> (0 until a.length()).map { a.getJSONObject(it).let { r -> AudioRange(r.optDouble("start"), r.optDouble("end")) } } })
fun selectionFromJson(j: JSONObject) = Selection(j.getString("story"), j.getString("bookTitle"), j.getString("edition"), chapterFromJson(j.getJSONObject("chapter")))
fun booksFromJson(j: JSONObject): List<Book> {
    val a = j.getJSONArray("books")
    return (0 until a.length()).map { i ->
        val b = a.getJSONObject(i); val editions = b.getJSONObject("editions")
        Book(b.getString("id"), b.getString("title"), b.optString("author"), editions.keys().asSequence().toList().associateWith { edition ->
            val c = editions.getJSONObject(edition).getJSONArray("chapters")
            (0 until c.length()).map { chapterFromJson(c.getJSONObject(it)) }
        }, b.optBoolean("autoDownload", false), b.optString("defaultEdition", editions.keys().asSequence().firstOrNull().orEmpty()))
    }
}
fun formatTime(seconds: Double): String {
    val total = seconds.toLong().coerceAtLeast(0)
    return if (total >= 3600) "%d:%02d:%02d".format(total / 3600, total / 60 % 60, total % 60) else "%d:%02d".format(total / 60, total % 60)
}

fun editionName(edition: String): String = when (edition) {
    "v3" -> "v3"
    "flash" -> "Flash"
    "qwen" -> "Qwen local"
    "chatterbox" -> "Chatterbox local"
    else -> edition
}


data class Passage(val id: String, val start: Double, val end: Double, val text: String, val sectionKind: String? = null, val startOffset: Int = -1, val endOffset: Int = -1)
data class Reading(val assembly: String, val passages: List<Passage>, val sectionMetadataVersion: Int = 0, val source: String = "")
data class ReaderFragment(val start: Int, val end: Int, val passage: Passage)
data class ReaderParagraph(val text: String, val fragments: List<ReaderFragment>)
fun bookParagraphs(reading: Reading, includeNotes: Boolean = true): List<ReaderParagraph> {
    var offset = 0
    val text = StringBuilder()
    val ranges = mutableListOf<ReaderFragment>()
    var omitted = false
    reading.passages.forEach { passage ->
        if (!includeNotes && passage.sectionKind == "author-note") omitted = true
        else {
            if (omitted && text.isNotEmpty()) { text.append("\n\n"); offset += 2 }
            omitted = false
            text.append(passage.text)
            ranges.add(ReaderFragment(offset, offset + passage.text.length, passage).also { offset = it.end })
        }
    }
    return Regex("[^\\r\\n]+").findAll(text.toString()).map { paragraph ->
        val start = paragraph.range.first
        val end = paragraph.range.last + 1
        ReaderParagraph(paragraph.value, ranges.filter { it.start < end && it.end > start }.map {
            ReaderFragment((it.start - start).coerceAtLeast(0), (it.end - start).coerceAtMost(paragraph.value.length), it.passage)
        })
    }.toList()
}
fun readingFromJson(j: JSONObject): Reading {
    val a = j.getJSONArray("passages")
    return Reading(j.getString("assembly"), (0 until a.length()).map { i -> val p = a.getJSONObject(i); Passage(p.getString("id"), p.getDouble("start"), p.getDouble("end"), p.getString("text"), p.optString("sectionKind").takeIf { it == "author-note" }, p.optInt("startOffset", -1), p.optInt("endOffset", -1)) }, j.optInt("sectionMetadataVersion", 0), j.optString("source"))
}

/** Keep edition-specific text and audio together; explicit device choices override server tags. */
fun downloadSelections(books: List<Book>, selected: (Book, String) -> Boolean): List<Selection> =
    books.flatMap { book -> book.editions.flatMap { (edition, chapters) ->
        if (selected(book, edition)) chapters.map { Selection(book.id, book.title, edition, it) } else emptyList()
    } }

/** Match a stable passage, never the other recording's unrelated timestamp. */
fun editionPosition(current: Reading, target: Reading, seconds: Double): Double? {
    val passage = current.passages.lastOrNull { it.start <= seconds } ?: current.passages.firstOrNull() ?: return null
    val fraction = if (passage.end > passage.start) ((seconds - passage.start) / (passage.end - passage.start)).coerceIn(0.0, 1.0) else 0.0
    val exact = target.passages.find { it.id == passage.id && it.text == passage.text }
    if (exact != null) return exact.start + fraction * (exact.end - exact.start)
    if (current.source.isEmpty() || current.source != target.source || passage.startOffset < 0 || passage.endOffset <= passage.startOffset) return null
    val offset = passage.startOffset + fraction * (passage.endOffset - passage.startOffset)
    val match = target.passages.find { it.startOffset >= 0 && it.endOffset > it.startOffset && offset >= it.startOffset && offset < it.endOffset } ?: return null
    return match.start + (offset - match.startOffset) / (match.endOffset - match.startOffset) * (match.end - match.start)
}
fun describeLocalLocation(selection: Selection, reading: Reading?, seconds: Double): JSONObject {
    val passage = reading?.passages?.lastOrNull { it.start <= seconds }
    return selection.location(seconds).put("bookTitle", selection.bookTitle).put("chapterId", selection.chapter.id).put("chapterTitle", selection.chapter.title)
        .put("chapter", selection.chapter.sequence).put("excerpt", passage?.text?.take(200).orEmpty()).put("selection", selection.json())
}
