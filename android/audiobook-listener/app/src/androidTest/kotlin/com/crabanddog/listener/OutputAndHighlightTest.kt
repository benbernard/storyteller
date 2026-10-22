package com.crabanddog.listener

import android.graphics.Bitmap
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class OutputAndHighlightTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private fun capture(name: String) {
        compose.waitForIdle()
        val directory = File(compose.activity.getExternalFilesDir(null), "output-highlight").apply { mkdirs() }
        File(directory, "$name.png").outputStream().use { instrumentation.uiAutomation.takeScreenshot().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun chooserWaitsForRoutingConfirmationAndCanSwitchBackAfterReopening() {
        var state by mutableStateOf(AudioOutputState(listOf(AudioOutput(1, "This phone", false), AudioOutput(2, "Test Bluetooth glasses", true)), routed = 2, available = true, playing = true))
        var open by mutableStateOf(true)
        val requests = mutableListOf<Int>()
        compose.setContent { ListenerTheme { if (open) OutputChoices(state, { requests.add(it); state = state.copy(requested = it) }, { state = state.copy(volume = it) }, {}, { open = false }) } }
        compose.onNodeWithText("This phone").performClick()
        compose.onNodeWithText("Switching…").assertIsDisplayed()
        compose.onNodeWithText("Test Bluetooth glasses").assertIsSelected()
        compose.runOnIdle { state = state.copy(routed = 1, requested = null) }
        compose.onNodeWithText("This phone").assertIsSelected()
        compose.onNodeWithText("Close").performClick()
        compose.runOnIdle { open = true }
        compose.onNodeWithText("Test Bluetooth glasses").performClick()
        compose.runOnIdle { state = state.copy(routed = 2, requested = null) }
        compose.onNodeWithText("Test Bluetooth glasses").assertIsSelected()
        compose.onNodeWithContentDescription("Listener volume").performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.SetProgress) { it(.35f) }
        compose.runOnIdle { assertEquals(listOf(1, 2), requests); assertEquals(.35f, state.volume) }
        assertEquals(0, compose.onNodeWithContentDescription("Listener volume").fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.ProgressBarRangeInfo].steps)
        capture("smooth-volume-and-confirmed-output")
        compose.runOnIdle { state = state.copy(requested = 1, error = "The output hasn’t changed. Try again.") }
        compose.onNodeWithText("Switch not confirmed").assertIsDisplayed()
        compose.onNodeWithText("Test Bluetooth glasses").assertIsSelected()
        capture("failed-switch-keeps-actual-output")
    }

    @Test fun onePassageKeepsBackgroundAndRuleAcrossParagraphGaps() {
        val reading = Reading("joined", listOf(Passage("before", 0.0, 5.0, "Before.\n\n"), Passage("active", 5.0, 20.0, "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\n"), Passage("after", 20.0, 30.0, "After.")))
        var mint = 0
        var teal = 0
        compose.setContent { ListenerTheme { mint = MaterialTheme.colorScheme.primaryContainer.toArgb(); teal = MaterialTheme.colorScheme.primary.toArgb(); PassageText(reading, 10.0, false, true, true, 16.64f, 0, {}, Modifier.fillMaxSize(), null, null, null, {}) } }
        compose.waitForIdle()
        val parent = compose.onNodeWithTag("passages").fetchSemanticsNode().boundsInRoot
        val first = compose.onNodeWithTag("reader-paragraph-1").fetchSemanticsNode().boundsInRoot
        val last = compose.onNodeWithTag("reader-paragraph-3").fetchSemanticsNode().boundsInRoot
        val pixels = compose.onNodeWithTag("passages").captureToImage().toPixelMap()
        val left = (first.left - parent.left).toInt()
        capture("continuous-passage-highlight")
        val bottomInset = (16 * compose.activity.resources.displayMetrics.density).toInt()
        for (y in (first.top - parent.top).toInt() + 8 until (last.bottom - parent.top).toInt() - bottomInset) {
            assertEquals("Continuous mint at y=$y", mint, pixels[left + 5, y].toArgb())
            assertEquals("Continuous rule at y=$y", teal, pixels[left, y].toArgb())
        }
        capture("continuous-passage-highlight")
    }

    @Test fun playerRoutesItsActualTrackWithoutSeekingOrResumingPausedAudio() {
        val context = instrumentation.targetContext
        val file = File(context.cacheDir, "output-test.mp3")
        instrumentation.context.assets.open("note-tone.mp3").use { source -> file.outputStream().use { source.copyTo(it) } }
        val outputs = AudioOutputs.get(context)
        lateinit var player: ExoPlayer
        var allocated: ExoPlayer? = null
        try {
            instrumentation.runOnMainSync {
                val renderer = object : DefaultRenderersFactory(context) {
                    override fun buildAudioSink(context: android.content.Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink = DefaultAudioSink.Builder(context).setAudioTrackProvider(outputs.trackProvider()).build()
                }
                player = ExoPlayer.Builder(context, renderer).build()
                allocated = player
                outputs.start(player)
                player.repeatMode = androidx.media3.common.Player.REPEAT_MODE_ONE
                player.setMediaItem(MediaItem.fromUri(Uri.fromFile(file)))
                player.prepare(); player.play()
            }
            compose.waitUntil(15000) { instrumentation.runOnMainSync { outputs.refresh() }; outputs.state.value.routed != null }
            val speaker = context.getSystemService(AudioManager::class.java).getDevices(AudioManager.GET_DEVICES_OUTPUTS).single { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
            instrumentation.runOnMainSync { outputs.select(speaker.id) }
            compose.waitUntil(10000) { instrumentation.runOnMainSync { outputs.refresh() }; outputs.state.value.routed == speaker.id && outputs.state.value.requested == null }
            instrumentation.runOnMainSync {
                player.pause()
                val before = player.currentPosition
                outputs.select(speaker.id); outputs.volume(.4f)
                assertFalse(player.playWhenReady)
                assertEquals(before, player.currentPosition)
                assertEquals(.4f, player.volume)
                assertEquals(speaker.id, outputs.state.value.routed)
            }
        } finally { instrumentation.runOnMainSync { outputs.stop(); allocated?.release() }; file.delete() }
    }
}
