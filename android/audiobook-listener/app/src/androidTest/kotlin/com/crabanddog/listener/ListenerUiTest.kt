package com.crabanddog.listener

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.json.JSONObject
import java.io.File

class ListenerUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val chapter = Chapter("one", 1, "Chapter 1 — A Study in Violet", "a".repeat(64), 420.0)
    private val book = Book("story", "Cruel Violet", "Author", mapOf("v3" to listOf(chapter), "flash" to listOf(chapter.copy(assembly = "b".repeat(64)))))
    private fun screen(state: ListenerUiState, onPlay: (Book, String, Chapter) -> Unit = { _, _, _ -> }, onIssue: (Selection, Double, String, String) -> Unit = { _, _, _, _ -> }, onPassage: (Double) -> Unit = {}, onReturn: (JSONObject) -> Unit = {}) {
        compose.activityRule.scenario.onActivity { it.enableEdgeToEdge() }
        compose.setContent { ListenerTheme { ListenerScreen(state, {}, {}, {}, onPlay, {}, {}, {}, onIssue, {}, {}, {}, onPassage = onPassage, onReturn = onReturn) } }
    }
    private fun screenshot(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val directory = File(instrumentation.targetContext.getExternalFilesDir(null), "screenshots").apply { mkdirs() }
        File(directory, "$name.png").outputStream().use { instrumentation.uiAutomation.takeScreenshot().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    @Test fun authorNoteCheckboxHasOneLabelledTargetAndToggles() {
        compose.setContent {
            var include by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(true) }
            ListenerTheme { ListenerScreen(ListenerUiState(connected = true, includeAuthorNotes = include), {}, {}, onPlay = { _, _, _ -> }, onToggle = {}, onSeek = {}, onSpeed = {}, onIssue = { _, _, _, _ -> }, onFinished = {}, onResolve = {}, onCharacters = {}, onIncludeAuthorNotes = { include = it }) }
        }
        compose.onNodeWithText("Tools", useUnmergedTree = true).performClick()
        compose.onNodeWithTag("include-author-notes").assertIsDisplayed().assertIsOn().assertHeightIsAtLeast(androidx.compose.ui.unit.Dp(48f))
        compose.onNodeWithText("Include author notes").assertIsDisplayed()
        screenshot("author-note-setting-enabled")
        compose.onNodeWithTag("include-author-notes").performClick().assertIsOff()
        screenshot("author-note-setting-disabled")
    }
    @Test fun libraryStartsWithTitlesAndDrillsIntoStory() {
        screen(ListenerUiState(connected = true, books = listOf(book), selection = Selection(book.id, book.title, "v3", chapter), position = 65.0))
        compose.onNodeWithText("Your stories").assertIsDisplayed()
        compose.onNodeWithText("1 unread audio chapter · 5:55 remaining").assertIsDisplayed()
        compose.onNodeWithText("Downloads").assertDoesNotExist()
        compose.onNodeWithText("Flash").assertDoesNotExist()
        screenshot("library-titles")
        compose.onAllNodesWithText(book.title).onFirst().performClick()
        compose.onNodeWithText("Back to library").assertIsDisplayed()
        compose.onNodeWithTag("story-chapters").performScrollToNode(hasTestTag("edition-picker"))
        compose.onNodeWithText("Flash").assertIsDisplayed()
        screenshot("story-detail")
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText("Your stories").assertIsDisplayed()
    }
    @Test fun repairQueueVisibleOnBookWithGenerationOff() {
        val repair = JSONObject("""{"title":"Audio repair in progress","detail":"Chapter 1 · Generating audio","completed":1,"total":3,"chapters":[{"id":"one","title":"Chapter 1","label":"Generating audio"},{"id":"two","title":"Chapter 2","label":"Queued for reanalysis and recasting"}]}""")
        val source = JSONObject().put("id", book.id).put("title", book.title).put("chapters", org.json.JSONArray()).put("repair", repair)
        screen(ListenerUiState(connected = true, books = listOf(book), catalog = listOf(source)))
        compose.onNodeWithText("Audio repair in progress").assertIsDisplayed()
        compose.onNodeWithText(book.title).performClick()
        compose.onNodeWithTag("story-chapters").performScrollToNode(hasText("Chapter repair queue"))
        compose.onNodeWithText("Chapter repair queue").performScrollTo().performClick()
        compose.onNodeWithText("Queued for reanalysis and recasting").performScrollTo().assertIsDisplayed()
        screenshot("repair-queue")
    }
    @Test fun reviewedPlanDoesNotShowAudioQueue() {
        val repair = JSONObject("""{"title":"Casting reviewed","detail":"Recast plan saved. Audio regeneration is not queued.","total":0}""")
        compose.setContent { ListenerTheme { RepairStatusPanel(repair) } }
        compose.onNodeWithText("Casting reviewed").assertIsDisplayed()
        compose.onNodeWithText("Recast plan saved. Audio regeneration is not queued.").assertIsDisplayed()
        compose.onNodeWithText("Chapter repair queue").assertDoesNotExist()
        screenshot("review-plan")
    }
    @Test fun signInHasAReachableAction() { screen(ListenerUiState()); compose.onNodeWithText("Connect account").assertIsDisplayed(); screenshot("connect") }
    @Test fun editionsChooseTheirOwnRecording() {
        var edition = ""
        screen(ListenerUiState(connected = true, books = listOf(book)), onPlay = { _, e, _ -> edition = e })
        compose.onNodeWithText(book.title).performClick()
        compose.onNodeWithText("Flash", useUnmergedTree = true).performScrollTo().performClick()
        screenshot("library")
        compose.onNodeWithTag("story-chapters").performScrollToNode(hasText(chapter.title, substring = false))
        compose.onNodeWithText(chapter.title, substring = false).performClick()
        compose.runOnIdle { assertEquals("flash", edition) }
    }
    @Test fun localEditionIsReachableAndUsesItsRecording() {
        var selected: Pair<String, String>? = null
        val local = chapter.copy(assembly = "c".repeat(64))
        val localBook = book.copy(editions = book.editions + ("qwen" to listOf(local)))
        screen(ListenerUiState(connected = true, books = listOf(localBook)), onPlay = { _, e, c -> selected = e to c.assembly })
        compose.onNodeWithText(book.title).performClick()
        compose.onNodeWithText("Qwen local", useUnmergedTree = true).performScrollTo().performClick()
        screenshot("qwen-library")
        compose.onNodeWithTag("story-chapters").performScrollToNode(hasText(chapter.title, substring = false))
        compose.onNodeWithText(chapter.title, substring = false).performClick()
        compose.runOnIdle { assertEquals("qwen" to local.assembly, selected) }
    }
    @Test fun untaggedEditionCanBeSelectedInTheApp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val audio = OfflineAudio(context)
        audio.prefs.edit().clear().commit()
        screen(ListenerUiState(connected = true, books = listOf(book)))
        compose.onNodeWithText(book.title).performClick()
        compose.onNodeWithTag("story-chapters").performScrollToNode(hasText("Download audio"))
        compose.onNodeWithText("Download audio").performScrollTo().performClick()
        compose.runOnIdle { assertTrue(OfflineAudio(context).selected(book, "v3")); assertFalse(audio.selected(book, "flash")) }
        compose.onNodeWithContentDescription("Keep Cruel Violet, v3, offline").performScrollTo().performClick()
        compose.runOnIdle { assertFalse(audio.selected(book, "v3")) }
        screenshot("book-download")
        audio.prefs.edit().clear().commit()
    }
    @Test fun readingTextFailureShowsSavedAudioAndReachableRetry() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val audio = OfflineAudio(context)
        audio.prefs.edit().clear().commit()
        audio.progress(20, 20)
        audio.status("20 of 20 audio chapters available offline. Reading text unavailable: 1. Its audio is saved.\nThe Allbright System — Who’s Who: reading text failed (Unable to read this item).")
        screen(ListenerUiState(connected = true, books = listOf(book)))
        compose.onNodeWithText("Tools", useUnmergedTree = true).performClick()
        compose.onNodeWithText("20 of 20 chapters saved").performScrollTo().assertIsDisplayed()
        screenshot("download-failure-status")
        compose.onNodeWithText("Retry downloads now").performScrollTo().assertIsDisplayed()
        audio.prefs.edit().clear().commit()
    }
    @Test fun downloadControlsAreReachable() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val audio = OfflineAudio(context); audio.prefs.edit().clear().commit()
        screen(ListenerUiState(connected = true, books = listOf(book)))
        compose.onNodeWithText("Tools", useUnmergedTree = true).performClick()
        compose.onNodeWithText("Download all available").performScrollTo().performClick()
        compose.runOnIdle { assertTrue(audio.selected(book, "v3")); assertTrue(audio.selected(book, "flash")) }
        compose.onNodeWithText("Pause downloads").performScrollTo().performClick()
        compose.runOnIdle { assertFalse(audio.enabled()) }
        compose.onNodeWithText("Resume downloads").performScrollTo().performClick()
        compose.runOnIdle { assertTrue(audio.enabled()) }
        compose.onNodeWithText("Downloads").performScrollTo().performClick()
        compose.onNodeWithText("Wi-Fi only").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("32 GB").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(32, audio.limitGb()) }
        compose.onNodeWithText("Clear downloads").performScrollTo().assertIsDisplayed()
        screenshot("download-settings")
        audio.prefs.edit().clear().commit()
    }
    @Test fun issueCapturesTheTimestampAndOptionalNote() {
        var saved: Triple<Double, String, String>? = null
        screen(ListenerUiState(connected = true, books = listOf(book), selection = Selection("story", "Cruel Violet", "v3", chapter), position = 65.0), onIssue = { selection, seconds, kind, note -> assertEquals(chapter.assembly, selection.chapter.assembly); saved = Triple(seconds, kind, note) })
        compose.onNodeWithText("Listening", useUnmergedTree = true).performClick()
        compose.onNodeWithContentDescription("Mark issue at 1:05").assertIsDisplayed().performClick()
        compose.onNodeWithText("Optional note").performClick().performTextInput("Voice changes here")
        screenshot("issue")
        compose.onNodeWithText("Save issue").performClick()
        compose.runOnIdle { assertEquals(Triple(65.0, "delivery", "Voice changes here"), saved) }
    }
    @Test fun offlineOutboxPersistsAndAcknowledgesOnlyTheSentEvent() {
        val store = ListenerStore.get(InstrumentationRegistry.getInstrumentation().targetContext)
        store.clear()
        val selected = Selection("story", "Cruel Violet", "v3", chapter)
        store.select(selected); store.saveProgress(selected, 22.0, true); store.saveProgress(selected, 24.0)
        store.issue(selected, 22.0, "voice", "First"); val first = store.outbox().last().getJSONObject("body").getString("eventId")
        store.issue(selected, 24.0, "delivery", "Second"); store.acknowledged(first)
        assertEquals(3, store.outbox().size)
        assertTrue(store.outbox().first().getJSONObject("body").getBoolean("completed"))
        assertFalse(store.outbox()[1].getJSONObject("body").getBoolean("completed"))
        assertEquals(22.0, store.outbox().first().getJSONObject("body").getDouble("seconds"), 0.0)
        assertEquals(24.0, store.position(selected), 0.0)
        assertEquals(0.0, store.position(selected.copy(edition = "flash")), 0.0)
        store.importProgress(JSONObject().put(selected.key, selected.location(1.0).put("deviceTime", 1)))
        assertEquals(24.0, store.position(selected), 0.0)
        store.clear()
    }
    @Test fun passagesSeekToTheirExactStartAndCanStopFollowing() {
        var target = -1.0
        val paragraphs = listOf(
            "The road narrowed beyond the last house. Violet stopped beside a broken gate and looked back at the town, where the windows were beginning to catch the evening light. Somewhere behind her, a bell rang twice. She had expected the journey to feel different once she was finally on her way.",
            "A folded map lay in her coat pocket. She took it out, smoothed the creases with her thumb, and tried to match the crooked line of the river to the water below. The bridge marked in blue was nowhere in sight. There was only an old footpath disappearing between the trees.",
            "“We could turn back,” Alex said. He set his bag on the low wall without looking at her. Dust had settled into the seams of his boots, and a leaf clung to the cuff of one trouser leg.",
            "Violet shook her head. They had come too far to spend another night discussing what might be waiting on the other side. She put the map away and stepped through the gate. The latch made a small, ordinary sound behind her.",
            "Under the trees, the air was cooler. Their footsteps sank into the soft ground, and for a while neither of them spoke. Violet kept one hand on the strap of her bag. Through a gap in the branches she could see the first pale star above the ridge.",
            "The path turned sharply downhill. At its foot stood a wooden bridge, narrow and weathered, with a single lamp burning at the far end. Someone had left it there for the travelers. That, more than anything, made her hesitate."
        )
        val reading = Reading(chapter.assembly, paragraphs.mapIndexed { index, text -> Passage("p$index", index * 20.0, (index + 1) * 20.0, text + "\n\n") })
        screen(ListenerUiState(connected = true, books = listOf(book), selection = Selection("story", "Cruel Violet", "v3", chapter), reading = reading, position = 25.0), onPassage = { target = it })
        compose.onNodeWithText("Listening", useUnmergedTree = true).performClick()
        compose.onNodeWithText("Following audio").performClick()
        compose.onNodeWithText("Follow audio").assertIsDisplayed()
        compose.onNodeWithTag("passages").performScrollToNode(hasText(paragraphs.first()))
        compose.onNodeWithText(paragraphs.first()).performTouchInput { click(topLeft + androidx.compose.ui.geometry.Offset(10f, 10f)) }
        compose.runOnIdle { assertEquals(0.0, target, 0.0) }
        screenshot("reading")
    }
    @Test fun historyCanRestoreTheLocationBeforeAJump() {
        var restored = -1.0
        val location = JSONObject().put("chapterTitle", chapter.title).put("seconds", 55.0).put("passageIndex", 2).put("edition", "qwen").put("storySeconds", 55.0).put("storyDuration", 420.0).put("excerpt", "A saved passage.")
        val event = JSONObject().put("eventId", "fixture").put("reason", "passage").put("deviceTime", 1000L).put("location", location).put("from", JSONObject(location.toString()).put("seconds", 22.0))
        screen(ListenerUiState(connected = true, history = listOf(event)), onReturn = { restored = it.getDouble("seconds") })
        compose.onNodeWithText("Tools", useUnmergedTree = true).performClick()
        compose.onNodeWithText("Location history", useUnmergedTree = true).performClick()
        compose.onNodeWithText("Before this jump").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(22.0, restored, 0.0) }
    }

}
