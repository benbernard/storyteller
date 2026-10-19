package com.crabanddog.listener

import org.junit.Assert.*
import org.junit.Test

class ChapterViewTest {
    @Test fun playbackClockRemovesNotesAndSeeksBackToTheSameSourceWords() {
        val view = ChapterView(120.0, listOf(AudioRange(10.0, 30.0), AudioRange(90.0, 120.0)))
        assertEquals(70.0, view.duration, 0.000001)
        for ((source, presented) in listOf(0.0 to 0.0, 9.0 to 9.0, 20.0 to 10.0, 30.0 to 10.0, 50.0 to 30.0, 110.0 to 70.0)) assertEquals(presented, view.position(source), 0.000001)
        assertEquals(30.0, view.source(10.0), 0.000001)
        assertEquals(50.0, view.source(30.0), 0.000001)
        assertEquals(120.0, view.source(70.0), 0.000001)
        for (source in listOf(0.0, 9.0, 30.0, 50.0, 89.0)) assertEquals(source, view.source(view.position(source)), 0.000001)
    }
    @Test fun notesDisappearFromReaderWithoutRemovingTheAnnouncementOrMergingWords() {
        val reading = Reading("a", listOf(Passage("title", 0.0, 2.0, "Chapter announcement.\n\n"), Passage("note", 2.0, 4.0, "Author note.", "author-note"), Passage("body", 4.0, 6.0, "Story body."), Passage("end-note", 6.0, 8.0, "End note.", "author-note"), Passage("tail", 8.0, 10.0, "Story tail.")), 1)
        val hidden = bookParagraphs(reading, false)
        assertEquals(listOf("Chapter announcement.", "Story body.", "Story tail."), hidden.map { it.text })
        assertEquals(listOf("title", "body", "tail"), hidden.flatMap { it.fragments }.map { it.passage.id })
        assertEquals(4.0, hidden[1].fragments.single().passage.start, 0.0)
        assertTrue(bookParagraphs(reading, true).any { it.text.contains("Author note.") })
    }
    @Test fun metadataRoundTripsAndUnknownOrInvalidRangesCannotRemoveContent() {
        val chapter = Chapter("one", 1, "One", "a", 10.0, authorNoteRanges = listOf(AudioRange(0.0, 2.0)))
        val selected = Selection("story", "Story", "test", chapter)
        assertEquals(chapter, selectionFromJson(selected.json()).chapter)
        assertEquals(8.0, chapterView(chapter, includeNotes = false).duration, 0.0)
        assertEquals(10.0, chapterView(chapter).duration, 0.0)
        assertEquals(10.0, ChapterView(10.0, listOf(AudioRange(-1.0, 2.0), AudioRange(0.0, 12.0), AudioRange(5.0, 4.0), AudioRange(Double.NaN, 7.0), AudioRange(10.05, 10.1))).duration, 0.0)
        assertEquals(0.0, ChapterView(10.0, listOf(AudioRange(0.0, 10.0))).duration, 0.0)
    }
    @Test fun oldUndoAnchorsInsideNotesReturnToThePrecedingReadablePassage() {
        val chapter = Chapter("one", 1, "One", "a", 10.0)
        val reading = Reading("a", listOf(Passage("title", 0.0, 2.0, "Title"), Passage("note", 2.0, 4.0, "Note", "author-note"), Passage("body", 4.0, 8.0, "Story"), Passage("after", 8.0, 10.0, "Note", "author-note")), 1)
        assertEquals(0.0, undoPosition(chapter, reading, false, 3.0), 0.0)
        assertEquals(4.0, undoPosition(chapter, reading, false, 9.0), 0.0)
        assertEquals(6.0, undoPosition(chapter, reading, false, 6.0), 0.0)
        assertEquals(3.0, undoPosition(chapter, reading, true, 3.0), 0.0)
    }
}
