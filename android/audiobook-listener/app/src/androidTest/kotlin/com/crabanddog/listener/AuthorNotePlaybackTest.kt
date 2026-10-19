package com.crabanddog.listener

import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.test.platform.app.InstrumentationRegistry
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit

class AuthorNotePlaybackTest {
    @Test fun servicePresentsNoteFreeTimelineOfflineAndKeepsSourceLocations() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val store = ListenerStore.get(context)
        context.stopService(Intent(context, PlaybackService::class.java))
        Thread.sleep(300)
        store.clear()
        assertTrue(store.includeAuthorNotes())
        val folder = File(context.cacheDir, "author-note-fixture").apply { mkdirs() }
        val files = (1..2).map { number ->
            val rate = 8000
            val bytes = rate * 8 * 2
            val wav = ByteBuffer.allocate(44 + bytes).order(ByteOrder.LITTLE_ENDIAN)
            wav.put("RIFF".toByteArray()).putInt(36 + bytes).put("WAVEfmt ".toByteArray()).putInt(16)
            wav.putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16).put("data".toByteArray()).putInt(bytes)
            repeat(bytes / 2) { frame -> wav.putShort((8000 * kotlin.math.sin(2 * Math.PI * 440 * frame / rate)).toInt().toShort()) }
            File(folder, "$number.wav").apply { writeBytes(wav.array()) }
        }
        val selected = files.mapIndexed { index, file -> Selection("fixture", "Fixture", "test", Chapter("chapter$index", index + 1, "Chapter $index", (if (index == 0) "a" else "b").repeat(64), 8.0, OfflineAudio.digest(file))) }
        fun reading(s: Selection): JSONObject {
            val passages = JSONArray()
            listOf(Triple(0.0, 1.2, "author-note"), Triple(1.2, 2.5, "body"), Triple(2.5, 3.5, "author-note"), Triple(3.5, 6.0, "body"), Triple(6.0, 7.899999999999, "author-note")).forEachIndexed { i, (start, end, kind) ->
                passages.put(JSONObject().put("id", "p$i").put("start", start).put("end", end).put("text", "Synthetic passage $i").apply { if (kind == "author-note") put("sectionKind", kind) })
            }
            return JSONObject().put("assembly", s.chapter.assembly).put("passages", passages).put("sectionMetadataVersion", 1)
        }
        selected.forEach { store.reading(it.chapter.assembly, reading(it)) }
        val originalHashes = files.map(OfflineAudio::digest)
        lateinit var future: ListenableFuture<MediaController>
        instrumentation.runOnMainSync { future = MediaController.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java))).buildAsync() }
        val controller = future.get(20, TimeUnit.SECONDS)
        fun onMain(block: () -> Unit) = instrumentation.runOnMainSync(block)
        fun await(condition: () -> Boolean) {
            val deadline = System.currentTimeMillis() + 10000
            while (true) {
                var ready = false
                onMain { ready = condition() }
                if (ready) return
                check(System.currentTimeMillis() < deadline) { "Playback condition timed out" }
                Thread.sleep(50)
            }
        }
        try {
            onMain {
                val items = selected.mapIndexed { index, s -> MediaItem.Builder().setMediaId(s.chapter.assembly).setUri(Uri.fromFile(files[index]))
                    .setMediaMetadata(MediaMetadata.Builder().setTitle(s.chapter.title).setExtras(Bundle().apply { putString("selection", s.json().toString()) }).build()).build() }
                controller.setMediaItems(items, 0, 500)
                controller.prepare()
            }
            await { controller.playbackState == androidx.media3.common.Player.STATE_READY }
            onMain { assertTrue(controller.currentPosition < 1200); store.includeAuthorNotes(false) }
            await { controller.duration in 3790..3810 && controller.currentPosition < 100 }
            onMain { assertFalse(controller.playWhenReady); controller.seekTo(1500) }
            await { controller.currentPosition in 1450..1550 }
            assertTrue(store.positions().any { it.optString("assembly") == selected[0].chapter.assembly && it.optDouble("seconds") in 3.65..3.75 })
            onMain { assertFalse(controller.playWhenReady); store.includeAuthorNotes(true); controller.seekTo(2700) }
            await { controller.currentPosition in 2600..3000 }
            await { store.positions().any { it.optString("assembly") == selected[0].chapter.assembly && it.optDouble("seconds") in 2.65..2.75 } }
            val undoBeforeSkip = store.undo()?.toString()
            onMain { store.includeAuthorNotes(false) }
            await { controller.currentPosition in 1250..1350 }
            assertEquals("Automatic note skip must not replace Undo", undoBeforeSkip, store.undo()?.toString())
            onMain { controller.seekTo(3500) }
            await { store.positions().any { it.optString("assembly") == selected[0].chapter.assembly && it.optDouble("seconds") in 5.65..5.75 } }
            val undoBeforeEnd = store.undo()?.toString()
            onMain { controller.play() }
            await { controller.currentMediaItemIndex == 1 && controller.currentPosition >= 0 && controller.isPlaying }
            assertEquals("Automatic chapter transition must not replace Undo", undoBeforeEnd, store.undo()?.toString())
            assertTrue(store.positions().any { it.optString("assembly") == selected[0].chapter.assembly && it.optBoolean("completed") })
            onMain { controller.pause(); controller.seekTo(0, 0) }
            await { controller.currentMediaItemIndex == 0 && controller.currentPosition < 100 }
            onMain { controller.seekTo(1, 2000) }
            await { controller.currentMediaItemIndex == 1 && controller.currentPosition in 1950..2050 }
            onMain { controller.seekBack() }
            await { controller.currentMediaItemIndex == 0 && controller.currentPosition < 100 && !controller.playWhenReady }
            onMain { controller.seekTo(1, 3800) }
            await { controller.currentMediaItemIndex == 1 && controller.currentPosition >= 3790 && !controller.playWhenReady }
            Thread.sleep(400)
            val completionCount = store.outbox().count { it.getJSONObject("body").optString("assembly") == selected[1].chapter.assembly && it.getJSONObject("body").optBoolean("completed") }
            assertTrue(completionCount > 0)
            Thread.sleep(400)
            assertEquals(completionCount, store.outbox().count { it.getJSONObject("body").optString("assembly") == selected[1].chapter.assembly && it.getJSONObject("body").optBoolean("completed") })
            onMain { controller.seekTo(2000); controller.play() }
            await { controller.isPlaying && controller.currentPosition in 2000..3790 }
            onMain { controller.pause() }
            onMain {
                controller.setMediaItem(MediaItem.Builder().setUri(Uri.fromFile(files[0])).setMediaMetadata(MediaMetadata.Builder().setTitle("Resume fixture")
                    .setExtras(Bundle().apply { putString("selection", selected[0].json().toString()) }).build()).build(), 500)
                controller.prepare()
            }
            await { controller.currentMediaItem?.mediaMetadata?.title == "Resume fixture" && controller.currentPosition in 450..550 && !controller.playWhenReady }
            val allNote = selected[0].copy(chapter = selected[0].chapter.copy(id = "all-note", assembly = "c".repeat(64)))
            store.reading(allNote.chapter.assembly, JSONObject().put("assembly", allNote.chapter.assembly).put("sectionMetadataVersion", 1)
                .put("passages", JSONArray().put(JSONObject().put("id", "note").put("start", 0).put("end", 8).put("text", "Synthetic note").put("sectionKind", "author-note"))))
            onMain {
                val items = listOf(allNote, selected[0]).map { s -> MediaItem.Builder().setUri(Uri.fromFile(files[0]))
                    .setMediaMetadata(MediaMetadata.Builder().setTitle(s.chapter.id).setExtras(Bundle().apply { putString("selection", s.json().toString()) }).build()).build() }
                controller.setMediaItems(items, 0, 0)
                controller.prepare()
            }
            await { controller.currentMediaItemIndex == 1 && controller.currentPosition < 100 && !controller.playWhenReady }
            onMain { controller.seekTo(1500) }
            await { controller.currentPosition in 1450..1550 }
            assertEquals(originalHashes, files.map(OfflineAudio::digest))
            assertFalse(store.includeAuthorNotes())
        } finally {
            onMain { controller.stop(); controller.clearMediaItems(); MediaController.releaseFuture(future) }
            context.stopService(Intent(context, PlaybackService::class.java))
            Thread.sleep(300)
            store.clear()
            folder.deleteRecursively()
        }
    }
}
