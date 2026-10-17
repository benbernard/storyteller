package com.crabanddog.listener

import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.test.platform.app.InstrumentationRegistry
import com.google.common.util.concurrent.ListenableFuture
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import android.net.Uri
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit

class PlaybackTest {
    @Test fun servicePlaysAndPersistsWithoutAnActivity() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val store = ListenerStore.get(context); store.clear()
        val rate = 22050; val dataBytes = rate * 12 * 2
        val wav = ByteBuffer.allocate(44 + dataBytes).order(ByteOrder.LITTLE_ENDIAN)
        wav.put("RIFF".toByteArray()).putInt(36 + dataBytes).put("WAVEfmt ".toByteArray()).putInt(16)
        wav.putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16).put("data".toByteArray()).putInt(dataBytes)
        repeat(dataBytes / 2) { wav.putShort((kotlin.math.sin(it * 2 * Math.PI * 220 / rate) * 1000).toInt().toShort()) }
        val file = File(context.cacheDir, "test-tone.wav").apply { writeBytes(wav.array()) }
        val checksum = OfflineAudio.digest(file)
        val selected = Selection("fixture", "Fixture", "v3", Chapter("one", 1, "Fixture chapter", "a".repeat(64), 12.0, checksum))
        val account = "b".repeat(64)
        store.library(JSONObject("""{"accountKey":"$account","books":[{"id":"fixture","title":"Fixture","author":"","editions":{"v3":{"chapters":[${selected.json().getJSONObject("chapter")}]}}}]}"""))
        val cached = File(context.filesDir, "offline-audio/$account/$checksum.mp3")
        cached.parentFile!!.mkdirs(); file.copyTo(cached, overwrite = true)
        val remote = Uri.parse("${ListenerApi.BASE}/stories/fixture/v3/audio/${selected.chapter.assembly}")
        assertEquals(Uri.fromFile(cached), OfflineAudio(context).resolve(remote))
        lateinit var future: ListenableFuture<MediaController>
        instrumentation.runOnMainSync { future = MediaController.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java))).buildAsync() }
        val controller = future.get(20, TimeUnit.SECONDS)
        try {
            instrumentation.runOnMainSync {
                controller.setMediaItem(MediaItem.Builder().setUri(remote).setMediaMetadata(MediaMetadata.Builder().setTitle("Fixture chapter")
                    .setExtras(Bundle().apply { putString("selection", selected.json().toString()) }).build()).build())
                controller.prepare(); controller.play()
            }
            Thread.sleep(6500)
            instrumentation.runOnMainSync { assertTrue(controller.isPlaying); assertTrue(controller.currentPosition > 3000); controller.pause() }
            Thread.sleep(500)
            assertTrue(store.position(selected) > 3.0)
            assertEquals(selected, store.selection())
            instrumentation.runOnMainSync { controller.seekTo(1000); controller.play() }
            Thread.sleep(1000)
            instrumentation.runOnMainSync { assertTrue(controller.currentPosition < 4000); controller.stop() }
            instrumentation.runOnMainSync { controller.clearMediaItems() }
            Thread.sleep(500)
            store.clear()
            Thread.sleep(5500)
            assertNull(store.selection())
            assertEquals(remote, OfflineAudio(context).resolve(remote))
            assertTrue(store.outbox().isEmpty())
        } finally {
            instrumentation.runOnMainSync { MediaController.releaseFuture(future) }
            context.stopService(Intent(context, PlaybackService::class.java))
            Thread.sleep(500); store.clear(); file.delete(); cached.delete()
        }
    }
}
