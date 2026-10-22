package com.crabanddog.listener

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.work.Configuration
import androidx.work.WorkManager
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class BookPagesTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val chapter = Chapter("one", 1, "A new beginning", "a".repeat(64), 300.0, "b".repeat(64))
    private val book = Book("rr-42", "The Allbright System", "Author", mapOf("qwen" to listOf(chapter)))
    private fun source() = JSONObject().put("id", book.id).put("title", book.title).put("supported", true).put("url", "https://www.royalroad.com/fiction/42")
        .put("follow", JSONObject().put("enabled", true).put("mode", "all"))
        .put("chapters", JSONArray().put(JSONObject()).put(JSONObject()))
        .put("job", JSONObject().put("id", "job").put("status", "running").put("phase", "Generating chapter 2"))
    @Before fun clear() {
        runCatching { WorkManager.getInstance(compose.activity) }.getOrElse { WorkManager.initialize(compose.activity, Configuration.Builder().build()) }
        OfflineAudio(compose.activity).prefs.edit().clear().commit()
        ListenerStore.get(compose.activity).clear()
        ListenerStore.get(compose.activity).library(JSONObject().put("accountKey", "c".repeat(64)))
        File(compose.activity.filesDir, "offline-audio").deleteRecursively()
    }
    @Test fun publishedCountDoesNotClaimWorkerProgress() {
        compose.setContent { ListenerTheme { PreparationPage(book, source(), ListenerUiState(canManage = true, canGenerate = true), {}, { _, _ -> }, {}) } }
        compose.onNodeWithText("1 of 2 chapters published").assertIsDisplayed()
        compose.onNodeWithText("Generating chapter 2").assertIsDisplayed()
        compose.onNodeWithContentDescription("Generate audiobook").assertDoesNotExist()
    }
    @Test fun failureCanRetryAndCancellationStaysReported() {
        var retried = false
        val source = source().put("job", JSONObject().put("id", "job").put("status", "failed").put("phase", "Needs attention").put("error", "Worker unavailable"))
        compose.setContent { ListenerTheme { PreparationPage(book, source, ListenerUiState(canManage = true, canGenerate = true), {}, { id, action -> retried = id == "job" && action == "retry" }, {}) } }
        compose.onNodeWithText("Retry").performScrollTo().performClick()
        compose.runOnIdle { assertTrue(retried) }
        compose.onNodeWithText("Worker unavailable").assertIsDisplayed()
    }
    @Test @Config(qualifiers = "w320dp-h844dp-mdpi")
    fun downloadRetryAndSettingsFitLargeText() {
        val audio = OfflineAudio(compose.activity)
        audio.progress(book.id, "qwen", "Reading text unavailable. Saved audio can still play.", retry = true)
        compose.setContent { CompositionLocalProvider(LocalDensity provides Density(1f, 2f)) { ListenerTheme { DownloadsPage(book, audio, {}) } } }
        compose.onNodeWithText("Retry downloads").performScrollTo().performClick()
        compose.runOnIdle { assertTrue(audio.requested(book.id, "qwen")) }
    }
    @Test fun settingsSaveIsExplicitAndScopedToCapturedBook() {
        var changed: Triple<String, Boolean, String>? = null
        compose.setContent { ListenerTheme { PreparationSettings(source(), ListenerUiState(canManage = true, canGenerate = true), { url, enabled, mode -> changed = Triple(url, enabled, mode) }, {}) } }
        compose.onNodeWithContentDescription("Automatic checks").performClick()
        compose.runOnIdle { assertNull(changed) }
        compose.onNodeWithText("Save settings").performClick()
        compose.runOnIdle { assertEquals(Triple("https://www.royalroad.com/fiction/42", false, "all"), changed) }
    }
    @Test fun offlineAndUnsupportedPreparationCannotMutate() {
        compose.setContent { ListenerTheme { PreparationSettings(source().put("supported", false), ListenerUiState(canManage = true, canGenerate = true, offline = true), { _, _, _ -> fail("Read-only preparation changed") }, {}) } }
        compose.onNodeWithText("Save settings").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Automatic checks").assertIsNotEnabled()
    }
    @Test fun clearBookKeepsOtherBooksOtherAccountsAndListeningPlace() {
        val store = ListenerStore.get(compose.activity); val audio = OfflineAudio(compose.activity)
        val shared = chapter.copy(id = "shared", assembly = "d".repeat(64), checksum = "e".repeat(64))
        val other = Book("other", "Other book", "Author", mapOf("v3" to listOf(shared)))
        val target = book.copy(editions = book.editions + ("flash" to listOf(shared)))
        val dir = File(compose.activity.filesDir, "offline-audio/${"c".repeat(64)}").apply { mkdirs() }
        File(dir, "${chapter.checksum}.mp3").writeText("target")
        File(dir, "${shared.checksum}.mp3").writeText("shared")
        val elsewhere = File(compose.activity.filesDir, "offline-audio/${"f".repeat(64)}").apply { mkdirs() }
        File(elsewhere, "${chapter.checksum}.mp3").writeText("other account")
        audio.select(target, "qwen", true); audio.select(target, "flash", true); audio.select(other, "v3", true)
        val selection = Selection(book.id, book.title, "qwen", chapter); store.saveProgress(selection, 42.0)
        audio.clearBook(target, listOf(target, other))
        assertFalse(File(dir, "${chapter.checksum}.mp3").exists()); assertTrue(File(dir, "${shared.checksum}.mp3").exists())
        assertTrue(File(elsewhere, "${chapter.checksum}.mp3").exists()); assertFalse(audio.selected(target, "qwen")); assertFalse(audio.selected(target, "flash")); assertTrue(audio.selected(other, "v3"))
        assertEquals(42.0, store.position(selection), .001)
    }
    @Test fun downloadChoicesStayWithAccount() {
        val store = ListenerStore.get(compose.activity); val audio = OfflineAudio(compose.activity)
        audio.select(book, "qwen", true)
        store.library(JSONObject().put("accountKey", "b".repeat(64))); assertFalse(audio.selected(book, "qwen"))
        store.library(JSONObject().put("accountKey", "c".repeat(64))); assertTrue(audio.selected(book, "qwen"))
    }
    @Test fun missingFileIsNeverClaimedAsDownloaded() {
        val audio = OfflineAudio(compose.activity); audio.prefs.edit().putBoolean("ready:${chapter.assembly}", true).commit()
        assertFalse(audio.ready(chapter))
        compose.setContent { ListenerTheme { DownloadsPage(book, audio, {}) } }
        compose.onNodeWithText("0 of 1 chapters downloaded").assertIsDisplayed()
    }
}
