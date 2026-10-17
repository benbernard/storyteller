package com.crabanddog.listener

import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.util.Base64
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.test.platform.app.InstrumentationRegistry
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.security.SecureRandom
import java.util.concurrent.TimeUnit

/** Opt-in deployment check. The harness approves a dedicated QA account, never the owner's account. */
class LiveFlowTest {
    @Test fun pairedDeviceStreamsAndSyncsAgainstDeployment() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("runLive") == "1")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val store = ListenerStore.get(context); store.clear()
        val credentials = Credentials(context); credentials.clear()
        val api = ListenerApi(context)
        val secret = Base64.encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) }, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        val pair = api.call("/pair/start", JSONObject().put("secret", secret), false)
        val codeFile = File(context.filesDir, "live-pair-code.txt").apply { writeText(pair.getString("code")) }
        var paired = false
        for (attempt in 0 until 90) {
            delay(1000)
            val result = api.call("/pair/poll", JSONObject().put("code", pair.getString("code")).put("secret", secret), false)
            if (result.has("token")) { credentials.write(result.getString("token")); paired = true; break }
        }
        assertTrue("Harness must approve the test pair within 90 seconds", paired)
        codeFile.delete()
        lateinit var future: ListenableFuture<MediaController>
        instrumentation.runOnMainSync { future = MediaController.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java))).buildAsync() }
        val controller = future.get(20, TimeUnit.SECONDS)
        try {
            val library = api.call("/library"); store.library(library)
            val book = booksFromJson(library).first { it.id == "rr-149733" }
            for ((edition, chapters) in book.editions) {
                val chapter = chapters.first()
                val selected = Selection(book.id, book.title, edition, chapter)
                if (edition == "qwen") {
                    val audio = OfflineAudio(context)
                    assertTrue("Published Qwen chapter must download", audio.download(credentials.read()!!, selected))
                    val cached = audio.file(chapter)
                    assertNotNull("Downloaded audio must match the published checksum", cached)
                    val remote = android.net.Uri.parse("${ListenerApi.BASE}/stories/${book.id}/$edition/audio/${chapter.assembly}")
                    assertEquals(android.net.Uri.fromFile(cached), audio.resolve(remote))
                    store.reading(chapter.assembly, api.call("/stories/${book.id}/$edition/text/${chapter.assembly}"))
                    assertTrue(readingFromJson(store.reading(chapter.assembly)!!).passages.isNotEmpty())
                }
                instrumentation.runOnMainSync {
                    controller.setMediaItem(MediaItem.Builder().setUri("${ListenerApi.BASE}/stories/${book.id}/$edition/audio/${chapter.assembly}")
                        .setMediaMetadata(MediaMetadata.Builder().setTitle(chapter.title).setExtras(Bundle().apply { putString("selection", selected.json().toString()) }).build()).build())
                    controller.prepare(); controller.play()
                }
                var played = false
                for (attempt in 0 until 40) {
                    delay(500)
                    instrumentation.runOnMainSync { played = controller.isPlaying && controller.currentPosition > 3000 }
                    if (played) break
                }
                assertTrue("Published $edition audio must play over HTTPS", played)
                instrumentation.runOnMainSync { controller.seekTo(65000); controller.pause() }
                delay(500); api.sync()
                val position = api.call("/library").getJSONObject("state").getJSONObject("positions").getJSONObject(selected.key)
                assertEquals(chapter.assembly, position.getString("assembly"))
                assertTrue(position.getDouble("seconds") >= 64)
                store.issue(selected, 65.0, "delivery", "Automated Listener deployment check; no content defect.")
                val event = store.outbox().last { it.getString("path") == "/issues" }.getJSONObject("body")
                api.sync()
                val repeated = api.call("/issues", event)
                assertEquals(chapter.assembly, repeated.getString("assembly"))
                assertTrue(repeated.getJSONArray("spans").length() > 0)
                api.call("/issues/resolve", JSONObject().put("id", repeated.getString("id")).put("resolved", true))
                assertEquals(0, store.outbox().size)
            }
            instrumentation.runOnMainSync { controller.stop() }
            api.call("/devices/revoke", JSONObject())
            assertTrue(runCatching { api.call("/library") }.isFailure)
        } finally {
            instrumentation.runOnMainSync { MediaController.releaseFuture(future) }
            context.stopService(Intent(context, PlaybackService::class.java))
            delay(500); credentials.clear(); OfflineAudio(context).clear(); store.clear(); codeFile.delete()
        }
    }
}
