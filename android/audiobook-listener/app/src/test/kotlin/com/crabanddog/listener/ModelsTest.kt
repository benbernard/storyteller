package com.crabanddog.listener

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ModelsTest {
    @Test fun manualDownloadsIncludeUntaggedBooksAndKeepEditionSpecificSelections() {
        val chapter = Chapter("one", 1, "One", "a".repeat(64), 60.0, "b".repeat(64))
        val book = Book("untagged", "Untagged", "Author", mapOf("v3" to listOf(chapter), "qwen" to listOf(chapter.copy(assembly = "c".repeat(64)))), false)
        val all = downloadSelections(listOf(book)) { _, _ -> true }
        assertEquals(listOf("v3", "qwen"), all.map { it.edition })
        assertEquals(listOf(chapter.assembly, "c".repeat(64)), all.map { it.chapter.assembly })
        assertEquals(listOf("v3"), downloadSelections(listOf(book)) { _, edition -> edition == "v3" }.map { it.edition })
        assertTrue(downloadSelections(listOf(book)) { _, _ -> false }.isEmpty())
    }

    @Test fun bookParagraphsKeepSeekTargetsAcrossRecordingAndParagraphBoundaries() {
        val first = Passage("first", 0.0, 10.0, "One sentence. ")
        val second = Passage("second", 10.0, 20.0, "Another sentence.\n\nA new paragraph.")
        val paragraphs = bookParagraphs(Reading("recording", listOf(first, second)))
        assertEquals(listOf("One sentence. Another sentence.", "A new paragraph."), paragraphs.map { it.text })
        assertEquals(listOf(0.0, 10.0), paragraphs[0].fragments.map { it.passage.start })
        assertEquals("Another sentence.", paragraphs[0].text.substring(paragraphs[0].fragments[1].start, paragraphs[0].fragments[1].end))
        assertEquals(10.0, paragraphs[1].fragments.single().passage.start, 0.0)
        assertEquals(paragraphs[1].text.length, paragraphs[1].fragments.single().end)
    }
    @Test fun localQwenEditionParsesAndKeepsItsOwnPositionKey() {
        val raw = JSONObject("""{"books":[{"id":"story","title":"Story","editions":{"qwen":{"chapters":[{"id":"one","sequence":1,"title":"One","assembly":"abc","duration":80.0}]}}}]}""")
        val book = booksFromJson(raw).single()
        val selected = Selection(book.id, book.title, "qwen", book.editions.getValue("qwen").single())
        assertEquals("Qwen local", editionName(selected.edition))
        assertNotEquals(selected.key, selected.copy(edition = "v3").key)
        assertEquals("qwen", selected.location(20.0).getString("edition"))
    }
    @Test fun selectionKeepsEditionAndAssemblySeparate() {
        val chapter = Chapter("chapter1", 1, "A chapter", "a".repeat(64), 75.0)
        val v3 = Selection("story", "Story", "v3", chapter)
        val flash = v3.copy(edition = "flash")
        assertNotEquals(v3.key, flash.key)
        assertEquals(v3, selectionFromJson(v3.json()))
        assertEquals(75.0, v3.location(100.0).getDouble("seconds"), 0.0)
        assertEquals(0.0, v3.location(-1.0).getDouble("seconds"), 0.0)
    }
    @Test fun libraryAcceptsAnEditionThatIsStillPreparing() {
        val raw = JSONObject("""{"books":[{"id":"story","title":"Story","author":"A","editions":{"v3":{"chapters":[{"id":"one","sequence":1,"title":"One","assembly":"abc","duration":80.0}]}}}]}""")
        val book = booksFromJson(raw).single()
        assertEquals(listOf("v3"), book.editions.keys.toList())
        assertEquals(1, book.editions.getValue("v3").size)
    }
    @Test fun clockFormattingHandlesLongChapters() { assertEquals("0:00", formatTime(-1.0)); assertEquals("1:01:01", formatTime(3661.0)) }
    @Test fun editionChangeMapsThePassageAcrossDifferentTimelines() {
        val old = Reading("old", listOf(Passage("node", 10.0, 30.0, "Words")))
        val target = Reading("new", listOf(Passage("node", 40.0, 50.0, "Words")))
        assertEquals(45.0, editionPosition(old, target, 20.0)!!, .001)
        assertNull(editionPosition(old, target.copy(passages = listOf(Passage("node", 40.0, 50.0, "Different words"))), 20.0))
    }
    @Test fun editionChangeMapsSourceOffsetWhenAnEditionSplitsTheNode() {
        val old = Reading("old", listOf(Passage("long", 0.0, 20.0, "0123456789", startOffset = 0, endOffset = 10)), source = "source")
        val target = Reading("new", listOf(Passage("first", 0.0, 10.0, "01234", startOffset = 0, endOffset = 5), Passage("second", 30.0, 40.0, "56789", startOffset = 5, endOffset = 10)), source = "source")
        assertEquals(35.0, editionPosition(old, target, 15.0)!!, .001)
        assertNull(editionPosition(old, target.copy(source = "changed"), 15.0))
    }
}
