package com.crabanddog.listener

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.MutableState
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.io.File

/** Reproducible actual-client captures using the approved mock's fictional content. */
class DesignParityTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val fixture by lazy { JSONObject(instrumentation.context.assets.open("listener-design.json").bufferedReader().use { it.readText() }) }
    private val apiFixture by lazy { fixture.getJSONObject("api") }
    private val books by lazy { booksFromJson(apiFixture.getJSONObject("library")) }
    private val book get() = books.first()
    private val selection by lazy { Selection(book.id, book.title, "v3", book.editions.getValue("v3")[11]) }
    private val reading by lazy { readingFromJson(apiFixture.getJSONObject("readings").getJSONObject(selection.chapter.assembly)) }
    private val catalog by lazy { jsonObjects(apiFixture.getJSONObject("catalog").getJSONArray("stories")).map { source -> JSONObject(source.toString()).apply { jsonObjects(apiFixture.getJSONObject("catalog").getJSONArray("jobs")).firstOrNull { it.optString("story") == source.getString("id") }?.let { put("job", it) } } } }
    private fun seedDownloads() {
        val store = ListenerStore.get(compose.activity)
        apiFixture.getJSONObject("readings").let { texts -> texts.keys().forEach { assembly -> store.reading(assembly, texts.getJSONObject(assembly)) } }
        store.library(apiFixture.getJSONObject("library")); store.importProgress(apiFixture.getJSONObject("library").getJSONObject("state").getJSONObject("positions"))
        val audio = OfflineAudio(compose.activity)
        val directory = File(compose.activity.filesDir, "offline-audio/${apiFixture.getJSONObject("library").getString("accountKey")}").apply { mkdirs() }
        val owned = JSONObject()
        book.editions.getValue("v3").take(10).forEach { chapter ->
            val bytes = ByteArray(8 * 1024 * 1024); bytes[0] = chapter.sequence.toByte()
            File(directory, "${chapter.checksum}.mp3").writeBytes(bytes)
            audio.prefs.edit().putBoolean("ready:${chapter.assembly}", true).commit()
            owned.put(chapter.assembly, chapter.checksum)
        }
        audio.prefs.edit().putString("files:${apiFixture.getJSONObject("library").getString("accountKey")}:${book.id}", owned.toString()).commit()
        audio.select(book, "v3", true)
        audio.progress(book.id, "v3", "Downloading", 2350000, 8388608, "Chapter 11 · Under the old bridge")
    }
    private fun covers(): Map<String, androidx.compose.ui.graphics.ImageBitmap> {
        val art = File(compose.activity.getExternalFilesDir(null), "design-covers.png")
        if (!art.exists()) return emptyMap()
        val bitmap = BitmapFactory.decodeFile(art.path)
        return listOf("lighthouse", "tides", "orchard", "midnight").mapIndexed { index, id -> id to Bitmap.createBitmap(bitmap, index % 2 * (bitmap.width/2), index / 2 * (bitmap.height/2), bitmap.width/2, bitmap.height/2).asImageBitmap() }.toMap()
    }
    private fun capture(name: String) {
        compose.waitForIdle()
        if ((name.startsWith("state-downloads") || name == "09-downloads") && compose.onAllNodesWithTag("book-identity").fetchSemanticsNodes().isNotEmpty()) compose.onNodeWithTag("book-identity").performScrollTo()
        if (name == "09-downloads") compose.waitUntil(15000) { compose.onAllNodes(hasText("Calculating downloaded size…", substring = true)).fetchSemanticsNodes().isEmpty() }
        instrumentation.waitForIdleSync()
        android.os.SystemClock.sleep(350) // Wait for the platform window fade before capturing.
        val dir = File(compose.activity.getExternalFilesDir(null), "design-parity").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { instrumentation.uiAutomation.takeScreenshot().compress(Bitmap.CompressFormat.PNG, 100, it) }
        if (compose.onAllNodesWithTag("listener-sheet").fetchSemanticsNodes().isNotEmpty()) File(dir, "$name-sheet.png").outputStream().use { compose.onNodeWithTag("listener-sheet").captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    private fun settleWindow() { compose.waitForIdle(); instrumentation.waitForIdleSync(); android.os.SystemClock.sleep(350) }
    private fun closeSheet() { compose.onNodeWithText("Close").performClick(); settleWindow() }
    private fun bookLink(label: String) { compose.onNodeWithTag("book-content").performScrollToNode(hasText(label)); compose.onNodeWithText(label, substring = false).performClick() }
    private fun initialState(): ListenerUiState {
        val saved = apiFixture.getJSONObject("library").getJSONObject("state")
        return ListenerUiState(connected = true, books = books, selection = selection, reading = reading, position = 496.0, accountLabel = "reader@example.test", canManage = true, canGenerate = true, catalog = catalog, catalogReportedAt = 1792630800000L,
            positions = saved.getJSONObject("positions").let { value -> value.keys().asSequence().map { value.getJSONObject(it) }.toList() }, issues = jsonObjects(saved.getJSONArray("issues")), completed = saved.getJSONObject("completed").keys().asSequence().toSet(),
            localJumps = jsonObjects(apiFixture.getJSONArray("history")))
    }
    private fun stateScreen(state: MutableState<ListenerUiState>, follow: (String, Boolean, String) -> Unit = { _, _, _ -> }) {
        val images = covers()
        compose.setContent { CompositionLocalProvider(LocalStoryCovers provides images) { ListenerTheme { ListenerScreen(state.value, {}, {}, {}, { _, _, _ -> }, {}, {}, {}, { _, _, _, _ -> }, {}, {}, {}, onFollow = follow, onSaveIssue = { _, _, _, _ -> false }) } } }
    }
    private fun chooseFilter(label: String) { compose.onNodeWithTag("library").performScrollToNode(hasText(label)); compose.onNodeWithText(label, substring = false).performClick() }
    private fun openBook() { chooseFilter("In progress"); compose.onNodeWithTag("library").performScrollToNode(hasText(book.title)); compose.onNode(hasText(book.title) and !hasTestTag("open-player")).performClick() }
    @Before fun reset() { ListenerStore.get(compose.activity).clear(); OfflineAudio(compose.activity).clear(); OfflineAudio(compose.activity).prefs.edit().clear().commit(); compose.activityRule.scenario.onActivity { it.enableEdgeToEdge() } }
    @Test fun approvedScreensAndSheets() {
        seedDownloads()
        val state = mutableStateOf(initialState())
        val images = covers()
        compose.setContent { CompositionLocalProvider(LocalStoryCovers provides images) { ListenerTheme { ListenerScreen(state.value, {}, {}, {}, { _, _, _ -> }, {}, {}, { speed -> state.value = state.value.copy(speed = speed) }, { _, _, _, _ -> }, {}, {}, {}, onEdition = { edition -> state.value = state.value.copy(selection = selection.copy(edition = edition, chapter = book.editions.getValue(edition)[11])) }, onIncludeAuthorNotes = { value -> state.value = state.value.copy(includeAuthorNotes = value) }) } } }
        capture("01-library")
        compose.onNodeWithTag("open-player").performClick(); capture("04-listening")
        compose.runOnIdle { state.value = state.value.copy(playing = true) }; capture("state-listening-playing")
        compose.onNodeWithContentDescription("Pause").assertIsDisplayed()
        compose.runOnIdle { state.value = state.value.copy(position = 481.0, undo = state.value.localJumps.first().getJSONObject("from")) }; capture("state-listening-playing-with-undo")
        compose.onNodeWithContentDescription("Undo jump").assertIsDisplayed()
        compose.runOnIdle { state.value = state.value.copy(position = 496.0, playing = false, undo = null) }
        compose.onNodeWithContentDescription("Listening settings").performClick(); capture("05-listening-settings")
        compose.onNodeWithText("The light swept across the harbour as June opened the letter.").performScrollTo().assertIsDisplayed()
        closeSheet()
        compose.onNodeWithText("1.0×").performClick(); capture("06-speed")
        compose.onNodeWithContentDescription("Custom speed").performScrollTo().performTextClearance()
        compose.onNodeWithContentDescription("Custom speed").performTextInput("9")
        compose.onNodeWithText("Apply speed").performScrollTo().performClick()
        compose.onNodeWithText("Enter a number from 0.1 to 4.0.").performScrollTo().assertIsDisplayed(); capture("06-speed-invalid")
        compose.onNodeWithContentDescription("Custom speed").performTextClearance()
        compose.onNodeWithContentDescription("Custom speed").performTextInput("1.35")
        compose.onNodeWithText("Apply speed").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(1.35f, state.value.speed) }; settleWindow()
        compose.onNodeWithContentDescription("Recent jumps").performClick(); capture("07-jumps"); closeSheet()
        compose.onNodeWithContentDescription("Mark issue").performClick(); capture("08-mark-issue")
        compose.onNodeWithText("Discard draft").performScrollTo().performClick(); settleWindow()
        compose.onNodeWithContentDescription("Back").performClick()
        openBook(); capture("02-book")
        bookLink("Chapters"); capture("03-chapters")
        compose.onNodeWithContentDescription("Find a chapter").performTextInput("12")
        compose.onNodeWithContentDescription("Find a chapter").performImeAction(); capture("03-chapters-current")
        compose.onNodeWithTag("chapter-content").performScrollToNode(hasText(selection.chapter.title))
        compose.onNodeWithText(selection.chapter.title).performClick()
        compose.onNodeWithTag("passages").performScrollToNode(hasText("Next chapter"))
        compose.onNodeWithText("Next chapter").performClick()
        compose.onNodeWithText("Browsing · Chapter 13").assertIsDisplayed()
        compose.runOnIdle { assertEquals(selection, state.value.selection) }; capture("04-browsing-next")
        compose.onNodeWithText("Back to audio").performClick()
        compose.runOnIdle { assertEquals(496.0, state.value.position, .001) }
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithContentDescription("Back").performClick()
        bookLink("Downloads"); capture("09-downloads")
        compose.onNodeWithContentDescription("Download settings").performClick(); capture("10-download-settings"); closeSheet()
        compose.onNodeWithContentDescription("Back").performClick()
        bookLink("Marked issues"); capture("11-marked-issues")
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithContentDescription("Back").performClick()
        chooseFilter("Not started")
        compose.onNodeWithText("The Glass Orchard").performClick()
        bookLink("Audio preparation"); capture("12-preparation")
        compose.onNodeWithContentDescription("Preparation settings").performClick(); capture("13-preparation-settings"); closeSheet()
        compose.onNodeWithContentDescription("Back").performClick(); compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithContentDescription("Account").performClick(); capture("14-account")
        compose.onNodeWithText("Sign out", substring = false).performScrollTo().performClick(); capture("15-sign-out")
        compose.onNodeWithText("Stay signed in").performScrollTo().assertIsDisplayed()
    }
    @Test fun audioOutputOpensThePlatformSelectorWithoutMovingPlayback() {
        val state = mutableStateOf(initialState())
        stateScreen(state)
        compose.onNodeWithTag("open-player").performClick()
        compose.onNodeWithContentDescription("Audio output").performClick()
        compose.waitUntil(10000) {
            instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() in setOf("com.android.systemui", "com.android.settings")
        }
        instrumentation.waitForIdleSync()
        android.os.SystemClock.sleep(500) // System panel transition is outside Compose’s animation clock.
        assertTrue(instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() in setOf("com.android.systemui", "com.android.settings"))
        val dir = File(compose.activity.getExternalFilesDir(null), "design-parity").apply { mkdirs() }
        File(dir, "state-system-audio-output.png").outputStream().use { instrumentation.uiAutomation.takeScreenshot().compress(Bitmap.CompressFormat.PNG, 100, it) }
        instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        compose.waitForIdle()
        compose.runOnIdle { assertEquals(selection, state.value.selection); assertEquals(496.0, state.value.position, .001) }
    }
    @Test fun signInAndWaitingScreens() {
        val state = mutableStateOf(ListenerUiState())
        compose.setContent { ListenerTheme { ListenerScreen(state.value, {}, {}, {}, { _, _, _ -> }, {}, {}, {}, { _, _, _, _ -> }, {}, {}, {}) } }
        capture("16-sign-in")
        compose.runOnIdle { state.value = state.value.copy(signInUrl = "https://example.test/signin") }
        compose.onNodeWithText("Sign in through your browser").assertIsDisplayed(); capture("17-sign-in-browser")
        compose.runOnIdle { state.value = state.value.copy(signInUrl = "", offline = true) }
        compose.onNodeWithText("Sign in", substring = false).assertIsNotEnabled(); capture("18-sign-in-offline")
    }
    @Test fun libraryReaderAndIssueRecoveryStates() {
        val state = mutableStateOf(ListenerUiState(connected = true, loading = true))
        stateScreen(state); capture("state-library-loading")
        compose.runOnIdle { state.value = state.value.copy(loading = false) }; capture("state-library-empty")
        compose.runOnIdle { state.value = initialState().copy(offline = true, message = "Couldn’t refresh. Your saved books are still here.") }; capture("state-library-offline")
        compose.onNodeWithContentDescription("Find a book").performTextInput("No matching story")
        compose.onNodeWithContentDescription("Find a book").performImeAction(); capture("state-library-no-results")
        compose.onNodeWithTag("library").performScrollToNode(hasText("Show all books"))
        compose.onNodeWithText("Show all books").performClick()
        compose.runOnIdle { state.value = state.value.copy(offline = false, message = "") }
        compose.onNodeWithTag("open-player").performClick()
        compose.onNodeWithContentDescription("Listening settings").performClick()
        compose.runOnIdle { state.value = state.value.copy(editionError = "This passage is unavailable in that edition. Your place is kept.") }; capture("state-edition-failure"); closeSheet()
        compose.onNodeWithContentDescription("Recent jumps").performClick()
        compose.runOnIdle { state.value = state.value.copy(localJumps = emptyList()) }; capture("state-jumps-empty")
        compose.runOnIdle { state.value = initialState().copy(offline = true, returnError = "That recording is unavailable. Your audio has not moved.") }; capture("state-jumps-offline-failure"); closeSheet()
        compose.runOnIdle { state.value = state.value.copy(offline = false) }
        compose.onNodeWithContentDescription("Mark issue").performClick()
        compose.onNodeWithContentDescription("Optional note").performTextInput("Keep this draft after a failed save.")
        compose.onNodeWithText("Save issue").performScrollTo().performClick()
        compose.onNodeWithText("Couldn’t save on this phone. Your draft is kept. Try again.").performScrollTo().assertIsDisplayed(); capture("state-issue-save-failure")
        compose.onNodeWithText("Close").performClick(); settleWindow()
        compose.onNodeWithContentDescription("Continue issue draft at 8:16").assertIsDisplayed()
        compose.runOnIdle { state.value = state.value.copy(message = "Offline · reports are saved on this phone.") }
        compose.onNodeWithContentDescription("Back").performClick(); openBook(); bookLink("Marked issues")
        compose.runOnIdle { state.value = state.value.copy(offline = true) }; capture("state-issues-offline")
        compose.runOnIdle { state.value = state.value.copy(offline = false, canManage = false) }; capture("state-issues-view-only")
        compose.runOnIdle { state.value = state.value.copy(issues = emptyList()) }; capture("state-issues-empty")
    }
    @Test fun downloadStatesAndBookMenu() {
        seedDownloads()
        val state = mutableStateOf(initialState()); stateScreen(state)
        openBook(); bookLink("Downloads")
        val audio = OfflineAudio(compose.activity)
        compose.onNodeWithText("Pause downloads").performScrollTo().performClick()
        compose.onNodeWithContentDescription("Keep this edition offline").assertIsOn(); capture("state-downloads-paused")
        for ((name,status) in listOf("wifi" to "Waiting for Wi-Fi", "connection" to "Waiting for a connection", "storage" to "Download storage limit reached", "failure" to "Reading text unavailable. Saved audio can still play.")) {
            compose.runOnIdle { audio.select(book, "v3", true); audio.progress(book.id, "v3", status, retry = name == "failure") }
            capture("state-downloads-$name")
        }
        compose.onNodeWithContentDescription("Download settings").performClick()
        compose.onNodeWithContentDescription("Edition to download").performScrollTo().performClick()
        compose.onNodeWithText("Flash", substring = false).performClick()
        compose.runOnIdle { assertEquals("v3", state.value.selection?.edition) }; capture("state-download-edition-independent"); closeSheet()
        compose.runOnIdle { audio.prefs.edit().putString("view-edition:${book.id}", "v3").commit(); state.value = state.value.copy(books = listOf(book.copy(editions = mapOf("v3" to book.editions.getValue("v3").take(10))))) }
        capture("state-downloads-complete")
        compose.runOnIdle { state.value = initialState() }
        compose.onNodeWithText("Clear this book’s downloads").performScrollTo().performClick(); capture("state-clear-downloads-confirmation")
        compose.onNodeWithText("Keep downloads").performScrollTo().performClick(); settleWindow()
        compose.runOnIdle { assertTrue(audio.hasBookDownloads(book)) }
        compose.onNodeWithContentDescription("Back").performClick(); compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithTag("library").performScrollToNode(hasContentDescription("More options for ${book.title}"))
        compose.onNodeWithContentDescription("More options for ${book.title}").performScrollTo().performClick(); capture("state-book-menu"); closeSheet()
        compose.runOnIdle { audio.clearBook(book, books) }
        openBook(); bookLink("Downloads"); capture("state-downloads-cleared")
        compose.onNodeWithText("Clear this book’s downloads").performScrollTo().assertIsNotEnabled()
    }
    @Test fun preparationStatesAndFailedSettingsSave() {
        val state = mutableStateOf(initialState())
        stateScreen(state) { _, _, _ -> state.value = state.value.copy(updatingStories = setOf("orchard")) }
        compose.onNodeWithTag("library").performScrollToNode(hasText("The Glass Orchard"))
        compose.onNodeWithText("The Glass Orchard").performClick(); bookLink("Audio preparation")
        val original = catalog.first { it.optString("id") == "orchard" }
        fun update(status: String, cancel: Boolean = false) {
            val changed = JSONObject(original.toString()).put("job", JSONObject().put("id", "fictional-preparation").put("status", status).put("phase", "Working on chapter 7.").put("cancel", cancel))
            compose.runOnIdle { state.value = initialState().copy(catalog = catalog.map { if (it.optString("id") == "orchard") changed else it }) }
        }
        for (status in listOf("queued", "running", "waiting", "failed", "cancelled", "complete")) { update(status); capture("state-preparation-$status") }
        update("running", true); compose.onNodeWithText("Cancellation requested").performScrollTo().assertIsDisplayed(); capture("state-preparation-cancellation-requested")
        update("running"); compose.runOnIdle { state.value = state.value.copy(offline = true) }; capture("state-preparation-offline")
        compose.runOnIdle { state.value = state.value.copy(offline = false, canManage = false) }; capture("state-preparation-view-only")
        compose.runOnIdle { state.value = state.value.copy(catalog = catalog.map { if (it.optString("id") == "orchard") JSONObject(it.toString()).put("supported", false) else it }) }; capture("state-preparation-unsupported")
        update("running")
        compose.onNodeWithContentDescription("Preparation settings").performClick()
        compose.onNodeWithContentDescription("Automatic checks").performScrollTo().performClick()
        compose.onNodeWithText("Save settings").performScrollTo().performClick(); compose.waitForIdle()
        compose.runOnIdle { state.value = state.value.copy(updatingStories = emptySet(), storyErrors = mapOf("orchard" to "Couldn’t save. Your choices are still here. Try again.")) }
        compose.onNodeWithContentDescription("Automatic checks").performScrollTo().assertIsOff(); capture("state-preparation-settings-save-failure")
    }

}
