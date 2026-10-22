package com.crabanddog.listener

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.json.JSONObject
import java.io.File

class ListenerUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val chapter = Chapter("one", 1, "Chapter 1 — A Study in Violet", "a".repeat(64), 420.0)
    private val book = Book("story", "Cruel Violet", "Author", mapOf("v3" to listOf(chapter), "flash" to listOf(chapter.copy(assembly = "b".repeat(64)))))
    private val selected = Selection(book.id, book.title, "v3", chapter)
    private val paragraphs = (0 until 30).map { i -> Passage("body-$i", i * 5.0, (i + 1) * 5.0, "Story passage $i. " + "The traveler continues along the road. ".repeat(4) + "\n\n") }
    private val reading = Reading(chapter.assembly, paragraphs, 1)
    @Before fun clear() { ListenerStore.get(compose.activity).clear(); OfflineAudio(compose.activity).prefs.edit().clear().commit() }
    private fun screen(state: ListenerUiState, onPlay: (Book, String, Chapter) -> Unit = { _, _, _ -> }, onIssue: (Selection, Double, String, String) -> Unit = { _, _, _, _ -> }, onPassage: (Double) -> Unit = {}, onReturn: (JSONObject) -> Unit = {}, onEdition: (String) -> Unit = {}) {
        compose.activityRule.scenario.onActivity { it.enableEdgeToEdge() }
        compose.setContent { ListenerTheme { ListenerScreen(state, {}, {}, {}, onPlay, {}, {}, {}, onIssue, {}, {}, {}, onPassage = onPassage, onReturn = onReturn, onEdition = onEdition) } }
    }
    private fun openReader() { compose.onNodeWithTag("open-player").performClick() }
    private fun screenshot(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val directory = File(instrumentation.targetContext.getExternalFilesDir(null), "screenshots").apply { mkdirs() }
        File(directory, "$name.png").outputStream().use { instrumentation.uiAutomation.takeScreenshot().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    @Test fun signInHasAReachableAction() { screen(ListenerUiState()); compose.onNodeWithText("Sign in").performScrollTo().assertIsDisplayed(); screenshot("sign-in") }
    @Test fun libraryAndChapterBackPreserveSearchWithoutStartingAudio() {
        var plays = 0
        screen(ListenerUiState(connected = true, books = listOf(book)), onPlay = { _, _, _ -> plays++ })
        compose.onNodeWithContentDescription("Find a book").performTextInput("Violet")
        compose.onNodeWithContentDescription("Find a book").performImeAction()
        compose.onNodeWithTag("library").performScrollToNode(hasText(book.title))
        compose.onNodeWithText(book.title).performClick()
        compose.onNodeWithContentDescription("Back").assertIsDisplayed()
        compose.onNodeWithTag("book-content").performScrollToNode(hasText("Chapters"))
        compose.onNodeWithText("Chapters").performClick()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNode(hasSetTextAction()).assertTextContains("Violet")
        compose.runOnIdle { assertEquals(0, plays) }
        compose.onNodeWithText(book.title).performClick()
        compose.onNodeWithTag("book-content").performScrollToNode(hasText("Chapters"))
        compose.onNodeWithText("Chapters").performClick()
        compose.onNodeWithContentDescription("Play ${chapter.title} from start").performClick()
        compose.runOnIdle { assertEquals(1, plays) }
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithContentDescription("Find a chapter").assertIsDisplayed()
        screenshot("chapters")
    }
    @Test fun compactReaderFollowsWithoutSeekingAndUsesOriginalTransportIcons() {
        var seeks = 0
        screen(ListenerUiState(connected = true, books = listOf(book), selection = selected, reading = reading, position = 61.0), onPassage = { seeks++ })
        openReader()
        compose.onNodeWithContentDescription("Back").assertIsDisplayed()
        compose.onNodeWithContentDescription("Play").assertIsDisplayed()
        compose.onNodeWithContentDescription("Back 15 seconds").assertIsDisplayed()
        compose.onNodeWithContentDescription("Ahead 30 seconds").assertIsDisplayed()
        compose.onNodeWithContentDescription("Audio output").assertIsDisplayed()
        compose.onNodeWithTag("passages").performTouchInput { swipeUp() }
        compose.onNodeWithText("Back to audio").performClick()
        compose.onNodeWithText("Following audio").assertIsDisplayed()
        compose.runOnIdle { assertEquals(0, seeks) }
        screenshot("listening")
    }
    @Test fun settingsHaveEditionsFontExampleAndOneAuthorNotesTarget() {
        var edition = ""
        compose.setContent {
            var include by remember { mutableStateOf(true) }
            ListenerTheme { ListenerScreen(ListenerUiState(connected = true, books = listOf(book), selection = selected, reading = reading, position = 61.0, includeAuthorNotes = include), {}, {}, onPlay = { _, _, _ -> }, onToggle = {}, onSeek = {}, onSpeed = {}, onIssue = { _, _, _, _ -> }, onFinished = {}, onResolve = {}, onCharacters = {}, onIncludeAuthorNotes = { include = it }, onEdition = { edition = it }) }
        }
        openReader(); compose.onNodeWithContentDescription("Listening settings").performClick()
        compose.onNodeWithText("Flash").performScrollTo().performClick()
        compose.onNodeWithText("The light swept across the harbour as June opened the letter.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("include-author-notes").performScrollTo().assertIsOn().performClick().assertIsOff()
        compose.onNodeWithText("Close").performClick()
        screenshot("settings-closed")
        assertEquals("flash", edition)
    }
    @Test fun passageTapUsesItsStartAndRecentJumpsUseDepartingPoint() {
        var target = -1.0; var restored = -1.0
        val from = selected.location(22.0).put("chapterTitle", chapter.title).put("excerpt", "A saved passage.")
        val event = JSONObject().put("eventId", "fixture").put("reason", "passage").put("deviceTime", 1000L).put("from", from)
        screen(ListenerUiState(connected = true, books = listOf(book), selection = selected, reading = reading, position = 61.0, localJumps = listOf(event)), onPassage = { target = it }, onReturn = { restored = it.getDouble("seconds") })
        openReader()
        compose.onNodeWithTag("passages").performScrollToIndex(0)
        compose.onNodeWithText(paragraphs.first().text.substringBefore("\n")).performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick) { it() }
        compose.runOnIdle { assertEquals(0.0, target, .001) }
        compose.onNodeWithContentDescription("Recent jumps").performClick()
        compose.onNodeWithText("A saved passage.").performClick()
        compose.runOnIdle { assertEquals(22.0, restored, .001) }
        screenshot("recent-jumps")
    }
    @Test fun issueDraftSurvivesDismissalAndSubmitsCapturedRecording() {
        var saved: Triple<Double, String, String>? = null
        screen(ListenerUiState(connected = true, books = listOf(book), selection = selected, reading = reading, position = 61.0), onIssue = { selection, seconds, kind, note -> assertEquals(chapter.assembly, selection.chapter.assembly); saved = Triple(seconds, kind, note) })
        openReader(); compose.onNodeWithContentDescription("Mark issue").performClick()
        compose.onNodeWithContentDescription("Optional note").performTextInput("Voice changes here")
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
        compose.waitForIdle()
        if (compose.onAllNodesWithTag("listener-sheet").fetchSemanticsNodes().isNotEmpty()) InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
        compose.waitForIdle()
        val store = ListenerStore.get(compose.activity)
        assertEquals("Voice changes here", store.draft(book.id)?.getString("note"))
        compose.onNodeWithContentDescription("Continue issue draft at 1:01").performClick()
        compose.onNodeWithText("Save issue").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(Triple(61.0, "delivery", "Voice changes here"), saved) }
        screenshot("issue-saved")
    }
    @Test fun authorNotesAreExcludedFromReaderAndClock() {
        val c = chapter.copy(duration = 120.0, authorNoteRanges = listOf(AudioRange(10.0, 30.0), AudioRange(90.0, 120.0)))
        val b = book.copy(editions = mapOf("v3" to listOf(c)))
        val text = Reading(c.assembly, listOf(Passage("title", 0.0, 10.0, "Chapter announcement.\n\n"), Passage("before", 10.0, 30.0, "Before author note.\n\n", "author-note"), Passage("body", 30.0, 90.0, "Actual chapter content.\n\n"), Passage("after", 90.0, 120.0, "After author note.", "author-note")), 1)
        screen(ListenerUiState(connected = true, books = listOf(b), selection = selected.copy(chapter = c), reading = text, position = 61.0, includeAuthorNotes = false))
        openReader()
        compose.onNodeWithText("Actual chapter content.").assertIsDisplayed()
        compose.onNodeWithText("Before author note.").assertDoesNotExist()
        compose.onNodeWithText("After author note.").assertDoesNotExist()
        compose.onNodeWithText("0:41").assertIsDisplayed(); compose.onNodeWithText("1:10").assertIsDisplayed()
        screenshot("author-notes-excluded")
    }
    @Test fun offlineOutboxKeepsDraftIdentityAndPermanentJumpOrigins() {
        val store = ListenerStore.get(compose.activity)
        val draft = describeLocalLocation(selected, reading, 22.0).put("eventId", "stable-issue").put("note", "First").put("kind", "voice")
        store.draft(book.id, draft); store.issue(selected, 22.0, "voice", "First")
        assertNull(store.draft(book.id)); assertEquals("stable-issue", store.pendingIssues().single().getString("eventId"))
        store.saveProgress(selected, 60.0, reason = "passage", from = describeLocalLocation(selected, reading, 22.0))
        val progress = store.outbox().last().getJSONObject("body")
        store.acknowledged(progress.getString("eventId"))
        assertEquals(22.0, store.recentJumps(book.id).single().getJSONObject("from").getDouble("seconds"), .001)
        store.importProgress(JSONObject().put(selected.key, selected.location(1.0).put("deviceTime", 1)))
        assertEquals(60.0, store.position(selected), .001)
    }
}
