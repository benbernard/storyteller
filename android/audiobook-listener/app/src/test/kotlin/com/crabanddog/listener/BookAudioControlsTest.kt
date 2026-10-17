package com.crabanddog.listener

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
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
class BookAudioControlsTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val chapter = Chapter("one", 1, "A new beginning", "a".repeat(64), 300.0, "b".repeat(64))
    private val book = Book("rr-42", "The Allbright System", "Author", mapOf("qwen" to listOf(chapter)))
    private fun source(enabled: Boolean = true) = JSONObject().put("id", book.id).put("title", book.title).put("supported", true)
        .put("follow", JSONObject().put("enabled", enabled).put("mode", "all"))
        .put("chapters", JSONArray().put(JSONObject()).put(JSONObject()))
        .put("job", JSONObject().put("id", "job").put("status", "running").put("phase", "Generating chapter 2"))
    @Before fun clear() {
        runCatching { WorkManager.getInstance(compose.activity) }.getOrElse {
            WorkManager.initialize(compose.activity, Configuration.Builder().build())
        }
        OfflineAudio(compose.activity).prefs.edit().clear().commit()
        ListenerStore.get(compose.activity).clear()
    }
    private fun render(source: JSONObject = source(), scale: Float = 1f, error: String? = null,
        onAudio: (String, Boolean) -> Unit = { _, _ -> }, onJob: (String, String) -> Unit = { _, _ -> }) {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(1f, scale)) {
                ListenerTheme { Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                    BookAudioControls(book.id, source, book, "qwen", false, error, onAudio, onJob)
                } }
            }
        }
    }
    private fun capture(name: String) {
        compose.waitForIdle()
        compose.runOnUiThread {
            val view = compose.activity.window.decorView
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(bitmap))
            val dir = File("build/reports/interface").apply { mkdirs() }
            File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }
    @Test fun togglesGenerationAndShowsSeparateDownloadProgress() {
        var changed: Pair<String, Boolean>? = null
        val audio = OfflineAudio(compose.activity)
        audio.progress(book.id, "qwen", "Downloading audio", 250, 1000, chapter.title)
        render(onAudio = { story, enabled -> changed = story to enabled })
        compose.onNodeWithText("1 of 2 chapters generated").assertIsDisplayed()
        compose.onNodeWithText("0 of 1 chapters downloaded").assertIsDisplayed()
        compose.onNodeWithText("25% of current chapter").performScrollTo().assertIsDisplayed()
        capture("book-progress")
        compose.onNodeWithContentDescription("Generate audiobook").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(book.id to false, changed) }
        compose.runOnIdle { audio.prefs.edit().putBoolean("ready:${chapter.assembly}", true).commit() }
        compose.onNodeWithText("1 of 1 chapters downloaded").assertIsDisplayed()
    }
    @Test fun failuresCanRetryAndSettingErrorsStayBesideTheSwitch() {
        var retried = false
        val source = source().put("job", JSONObject().put("id", "job").put("status", "failed").put("phase", "Needs attention").put("error", "Audio worker is unavailable"))
        render(source, error = "Could not save. Try again.", onJob = { id, action -> retried = id == "job" && action == "retry" })
        compose.onNodeWithText("Could not save. Try again.").assertIsDisplayed()
        compose.onNodeWithText("Retry generation").performScrollTo().performClick()
        compose.runOnIdle { assertTrue(retried) }
        capture("book-failure")
    }
    @Test @Config(qualifiers = "w320dp-h844dp-mdpi")
    fun missingReadingTextCanRetryEvenWhenAllAudioIsSaved() {
        val audio = OfflineAudio(compose.activity)
        audio.prefs.edit().putBoolean("ready:${chapter.assembly}", true).commit()
        audio.progress(book.id, "qwen", "Reading text unavailable. Saved audio can still play.", retry = true)
        render(scale = 2f)
        compose.onNodeWithText("1 of 1 chapters downloaded").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Retry downloads").performScrollTo().assertIsDisplayed()
        capture("book-text-retry")
        compose.onNodeWithText("Retry downloads").performClick()
        compose.runOnIdle { assertTrue(audio.requested(book.id, "qwen")); assertTrue(audio.ready(chapter)) }
    }
    @Test fun unsupportedBookCannotEnableGeneration() {
        render(source(false).put("supported", false).put("description", "Choose an EPUB with selectable text."))
        compose.onNodeWithContentDescription("Generate audiobook").assertIsNotEnabled()
        compose.onNodeWithText("Choose an EPUB with selectable text.").assertIsDisplayed()
    }
    @Test @Config(qualifiers = "w320dp-h844dp-mdpi")
    fun narrowLargeTextKeepsDownloadActionReachable() {
        render(scale = 2f)
        compose.onNodeWithText("Download audio").performScrollTo().assertIsDisplayed()
        capture("book-large-text")
    }
    @Test @Config(qualifiers = "w840dp-h390dp-land-night-mdpi")
    fun darkLandscapeKeepsProgressAndActionsReachable() {
        render()
        compose.onNodeWithText("Download audio").performScrollTo().assertIsDisplayed()
        capture("book-dark-landscape")
    }
    @Test fun pausedDownloadCanResumeAndKeepTheSelectedEdition() {
        val audio = OfflineAudio(compose.activity)
        audio.pause(book.id, "qwen")
        audio.prefs.edit().putBoolean("enabled", false).commit()
        render()
        compose.onNodeWithText("Resume downloads").performScrollTo().performClick()
        compose.runOnIdle {
            assertTrue(audio.requested(book.id, "qwen")); assertFalse(audio.paused(book.id, "qwen")); assertTrue(audio.enabled())
            audio.pause(); assertFalse(audio.enabled()); assertTrue(audio.requested(book.id, "qwen"))
        }
    }
    @Test fun libraryCanFindAndOpenAnUntaggedBook() {
        val source = source(false).put("author", "Author").put("url", "https://www.royalroad.com/fiction/42")
        compose.setContent {
            ListenerTheme { ListenerScreen(ListenerUiState(connected = true, catalog = listOf(source)), {}, {},
                onPlay = { _, _, _ -> }, onToggle = {}, onSeek = {}, onSpeed = {}, onIssue = { _, _, _, _ -> },
                onFinished = {}, onResolve = {}, onCharacters = {}) }
        }
        compose.onNodeWithText("Find a book").performTextInput("Allbright")
        compose.onNodeWithText(book.title).performClick()
        compose.onNodeWithContentDescription("Generate audiobook").performScrollTo().assertIsDisplayed().assertIsOff()
        capture("untagged-book")
    }
    @Test fun downloadChoicesStayWithThePairedAccount() {
        val store = ListenerStore.get(compose.activity)
        val audio = OfflineAudio(compose.activity)
        store.library(JSONObject().put("accountKey", "a".repeat(64)))
        audio.select(book, "qwen", true)
        store.library(JSONObject().put("accountKey", "b".repeat(64)))
        assertFalse(audio.selected(book, "qwen"))
        store.library(JSONObject().put("accountKey", "a".repeat(64)))
        assertTrue(audio.selected(book, "qwen"))
    }
    @Test fun toolsCanDownloadAllAndPauseWithoutLosingSelections() {
        val editions = book.copy(editions = book.editions + ("flash" to listOf(chapter)))
        val audio = OfflineAudio(compose.activity)
        compose.setContent {
            ListenerTheme { ListenerScreen(ListenerUiState(connected = true, books = listOf(editions)), {}, {},
                onPlay = { _, _, _ -> }, onToggle = {}, onSeek = {}, onSpeed = {}, onIssue = { _, _, _, _ -> },
                onFinished = {}, onResolve = {}, onCharacters = {}) }
        }
        compose.onNodeWithText("Tools", useUnmergedTree = true).performClick()
        compose.onNodeWithText("Download all available").performScrollTo().performClick()
        compose.runOnIdle { assertTrue(audio.selected(editions, "qwen")); assertTrue(audio.selected(editions, "flash")) }
        compose.onNodeWithText("Pause downloads").performScrollTo().performClick()
        compose.runOnIdle { assertFalse(audio.enabled()); assertTrue(audio.selected(editions, "flash")) }
        capture("download-all")
    }
}
