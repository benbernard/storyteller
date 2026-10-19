package com.crabanddog.listener

import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class AuthorNoteOutputTest {
    @Test fun decodedMp3OutputContainsNoNoteSamplesAcrossPrefetchedChaptersOrDelayedCallbacks() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val clip = File(context.cacheDir, "note-output.mp3")
        instrumentation.context.assets.open("note-tone.mp3").use { input -> clip.outputStream().use { input.copyTo(it) } }
        val selections = (0..1).map { index -> Selection("tone", "Synthetic tone", "test", Chapter("$index", index, "Chapter $index", (if(index == 0) "a" else "b").repeat(64), 4.0)) }
        val readings = selections.mapIndexed { index, s -> Reading(s.chapter.assembly, listOf(Passage("note", if(index == 0) 1.0 else 0.0, if(index == 0) 2.0 else 1.0, "Synthetic note", "author-note")), 1) }.associateBy { it.assembly }
        for (include in listOf(false, true)) {
            val output = ByteArrayOutputStream()
            var sampleRate = 0
            val capture = object : BaseAudioProcessor() {
                override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
                    sampleRate = inputAudioFormat.sampleRate
                    assertEquals(2, inputAudioFormat.bytesPerFrame)
                    return inputAudioFormat
                }
                override fun queueInput(inputBuffer: ByteBuffer) {
                    if (!inputBuffer.hasRemaining()) return
                    val bytes = ByteArray(inputBuffer.remaining()); inputBuffer.duplicate().get(bytes)
                    synchronized(output) { output.write(bytes) }
                    replaceOutputBuffer(inputBuffer.remaining()).apply { put(inputBuffer); flip() }
                }
            }
            val policy = AuthorNoteAudioPolicy(include)
            lateinit var player: ExoPlayer
            instrumentation.runOnMainSync {
                val renderers = object : DefaultRenderersFactory(context) {
                    override fun buildAudioSink(context: android.content.Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink =
                        AuthorNoteAudioSink(DefaultAudioSink.Builder(context).setAudioProcessors(arrayOf(capture)).build(), policy)
                }
                player = ExoPlayer.Builder(context, renderers).setMediaSourceFactory(NoteMediaSourceFactory(DefaultDataSource.Factory(context), policy, onPending = { selected ->
                    android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ policy.update(selected, readings[selected.chapter.assembly], false) }, 300)
                }) { if (!include && it.chapter.assembly == selections[1].chapter.assembly) null else readings[it.chapter.assembly] }).build()
                player.setMediaItems(selections.map { s -> MediaItem.Builder().setUri(Uri.fromFile(clip)).setMediaMetadata(MediaMetadata.Builder().setExtras(Bundle().apply { putString("selection", s.json().toString()) }).build()).build() })
                player.setPlaybackSpeed(2f);player.prepare();player.play()
            }
            try {
                val deadline = System.currentTimeMillis() + 20000
                var stalled = false
                while (true) {
                    var ended = false
                    instrumentation.runOnMainSync {
                        player.playerError?.let { throw it }
                        ended = player.playbackState == Player.STATE_ENDED
                        if (!stalled && player.isPlaying) { stalled = true; Thread.sleep(750) }
                    }
                    if (ended) break
                    check(System.currentTimeMillis() < deadline) { "Tone playback timed out" }
                    Thread.sleep(30)
                }
                val pcm = synchronized(output) { output.toByteArray() }
                assertTrue("Both chapters reached output", pcm.size > sampleRate * 2 * 7.9)
                val samples = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                fun peak(start: Double, end: Double): Int = ((start * sampleRate).toInt() until (end * sampleRate).toInt()).maxOf { kotlin.math.abs(samples.get(it).toInt()) }
                assertTrue("Announcement/body audio is retained", peak(.1, .9) > 1000)
                assertTrue("Later chapter content is retained", peak(5.1, 5.9) > 1000)
                if (include) {
                    assertTrue(peak(1.01, 1.99) > 1000);assertTrue(peak(4.01, 4.99) > 1000)
                } else {
                    assertEquals("No first-note PCM reaches the output", 0, peak(1.001, 1.999))
                    assertEquals("Prefetched next-chapter note is also silent", 0, peak(4.001, 4.999))
                }
            } finally { instrumentation.runOnMainSync { player.release() } }
        }
        clip.delete()
    }
}
