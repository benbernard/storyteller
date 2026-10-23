package com.crabanddog.listener

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class ContinuationTest {
    private lateinit var store: ListenerStore
    private val first = Selection("story", "A book", "Inworld", Chapter("one", 1, "One", "a".repeat(64), 100.0))
    @Before fun reset() { store = ListenerStore.get(RuntimeEnvironment.getApplication()); store.clear() }
    @Test fun staleSessionRetainsHistoryWithoutReplacingReadingHandoff() {
        store.saveProgress(first, 15.0)
        val next = first.copy(chapter = first.chapter.copy(id = "two", assembly = "b".repeat(64)), continuationRevision = 1)
        val incoming = next.location(0.0).put("eventId", "handoff").put("deviceTime", 1).put("continuationRevision", 1)
        store.importProgress(JSONObject().put(next.key, incoming), JSONObject().put("story", JSONObject().put("revision", 1)))
        store.saveProgress(first, 90.0)
        val book = Book("story", "A book", "Author", mapOf("Inworld" to listOf(first.chapter, next.chapter)))
        val summary = listeningSummary(book, ListenerUiState(selection = first, position = 90.0, positions = store.positions()))
        assertEquals(next.chapter.assembly, summary.latest!!.getString("assembly"))
        assertEquals("b".repeat(64), store.latestLocation()!!.getString("assembly"))
        assertEquals(2, store.outbox().size)
        store.saveProgress(next, 5.0)
        assertEquals(5.0, store.position(next), .001)
    }
    @Test fun revisionsDoNotRankDifferentBooks() {
        val a = JSONObject().put("story", "a").put("continuationRevision", 9).put("deviceTime", 10)
        val staleA = JSONObject().put("story", "a").put("continuationRevision", 0).put("deviceTime", 9999)
        val b = JSONObject().put("story", "b").put("continuationRevision", 0).put("deviceTime", 20)
        val current = currentContinuationPositions(listOf(a, staleA, b))
        assertEquals("b", current.first().getString("story"))
        assertEquals(2, current.size)
    }
}
