package com.crabanddog.listener

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AuthorNotesTest {
    @Test fun legacyAndUnknownSectionsRemainOrdinaryContent() {
        val raw = JSONObject("""{"assembly":"a","passages":[{"id":"old","start":0,"end":2,"text":"Legacy author note label"},{"id":"unknown","start":2,"end":4,"text":"Unknown","sectionKind":"other"},{"id":"note","start":4,"end":6,"text":"Note","sectionKind":"author-note"}]}""")
        val reading = readingFromJson(raw)
        assertEquals(0, reading.sectionMetadataVersion)
        assertTrue(needsSectionRefresh(reading))
        assertTrue(needsSectionRefresh(null))
        val known = readingFromJson(JSONObject(raw.toString()).put("sectionMetadataVersion", 1))
        assertFalse(needsSectionRefresh(known))
        assertFalse(needsSectionRefresh(Reading("no-notes", emptyList(), 1)))
        assertNull(reading.passages[0].sectionKind)
        assertNull(reading.passages[1].sectionKind)
        assertEquals("author-note", reading.passages[2].sectionKind)
        assertNull(authorNoteEnd(reading, 1.0, 6.0))
        assertNull(authorNoteEnd(reading, 3.0, 6.0))
        assertEquals(6.0, authorNoteEnd(reading, 4.0, 6.0)!!, 0.0)
        assertNull(authorNoteEnd(reading, 6.0, 6.0))
    }
    @Test fun noteSkipsMergeOnlyTouchingRangesAndKeepAbsoluteTimeline() {
        val reading = Reading("a", listOf(Passage("later", 8.0, 10.0, "", "author-note"), Passage("first", 2.0, 4.0, "", "author-note"), Passage("next", 4.0, 5.0, "", "author-note")))
        assertEquals(5.0, authorNoteEnd(reading, 3.0, 10.0)!!, 0.0)
        assertNull(authorNoteEnd(reading, 5.0, 10.0))
        assertNull(authorNoteEnd(reading, 7.0, 10.0))
        assertEquals(10.0, authorNoteEnd(reading, 9.0, 10.0)!!, 0.0)
        assertNull(authorNoteEnd(null, 3.0, 10.0))
    }
    @Test fun malformedTagsCannotSkipStoryAudio() {
        val reading = Reading("a", listOf(Passage("negative", -1.0, 3.0, "", "author-note"), Passage("reversed", 4.0, 2.0, "", "author-note"), Passage("tooLong", 1.0, 11.0, "", "author-note"), Passage("nan", Double.NaN, 4.0, "", "author-note")))
        assertNull(authorNoteEnd(reading, 2.0, 10.0))
        assertNull(authorNoteEnd(reading, Double.NaN, 10.0))
        assertNull(authorNoteEnd(reading, 2.0, Double.POSITIVE_INFINITY))
    }
    @Test fun finalJoinPauseCompletesWithFloatToleranceButOrdinaryTailIsRetained() {
        val note = Passage("note", 6.0, 7.899999999999, "", "author-note")
        assertEquals(8.0, authorNoteEnd(Reading("a", listOf(note), 1), 6.5, 8.0)!!, 0.0)
        val ordinary = Passage("tail", 7.9, 8.0, "Ordinary ending")
        assertEquals(note.end, authorNoteEnd(Reading("a", listOf(note, ordinary), 1), 6.5, 8.0)!!, 0.0)
    }
}
