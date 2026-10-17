package com.crabanddog.listener

import org.json.JSONObject

data class Chapter(val id: String, val sequence: Int, val title: String, val assembly: String, val duration: Double, val checksum: String = "")
data class Book(val id: String, val title: String, val author: String, val editions: Map<String, List<Chapter>>, val autoDownload: Boolean = false, val defaultEdition: String = editions.keys.firstOrNull().orEmpty())
data class Selection(val story: String, val bookTitle: String, val edition: String, val chapter: Chapter) {
    val key get() = "$story:$edition:${chapter.id}"
    fun json() = JSONObject().put("story", story).put("bookTitle", bookTitle).put("edition", edition)
        .put("chapter", JSONObject().put("id", chapter.id).put("sequence", chapter.sequence).put("title", chapter.title).put("assembly", chapter.assembly).put("duration", chapter.duration).put("checksum", chapter.checksum))
    fun location(seconds: Double) = JSONObject().put("story", story).put("edition", edition).put("assembly", chapter.assembly).put("seconds", seconds.coerceIn(0.0, chapter.duration))
}
fun chapterFromJson(j: JSONObject) = Chapter(j.getString("id"), j.getInt("sequence"), j.getString("title"), j.getString("assembly"), j.getDouble("duration"), j.optString("checksum"))
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


data class Passage(val id: String, val start: Double, val end: Double, val text: String)
data class Reading(val assembly: String, val passages: List<Passage>)
data class ReaderFragment(val start: Int, val end: Int, val passage: Passage)
data class ReaderParagraph(val text: String, val fragments: List<ReaderFragment>)
fun bookParagraphs(reading: Reading): List<ReaderParagraph> {
    var offset = 0
    val ranges = reading.passages.map { passage ->
        ReaderFragment(offset, offset + passage.text.length, passage).also { offset = it.end }
    }
    val text = reading.passages.joinToString("") { it.text }
    return Regex("[^\\r\\n]+").findAll(text).map { paragraph ->
        val start = paragraph.range.first
        val end = paragraph.range.last + 1
        ReaderParagraph(paragraph.value, ranges.filter { it.start < end && it.end > start }.map {
            ReaderFragment((it.start - start).coerceAtLeast(0), (it.end - start).coerceAtMost(paragraph.value.length), it.passage)
        })
    }.toList()
}
fun readingFromJson(j: JSONObject): Reading {
    val a = j.getJSONArray("passages")
    return Reading(j.getString("assembly"), (0 until a.length()).map { i -> val p = a.getJSONObject(i); Passage(p.getString("id"), p.getDouble("start"), p.getDouble("end"), p.getString("text")) })
}

/** Keep edition-specific text and audio together; explicit device choices override server tags. */
fun downloadSelections(books: List<Book>, selected: (Book, String) -> Boolean): List<Selection> =
    books.flatMap { book -> book.editions.flatMap { (edition, chapters) ->
        if (selected(book, edition)) chapters.map { Selection(book.id, book.title, edition, it) } else emptyList()
    } }
