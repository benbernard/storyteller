package com.crabanddog.listener

import android.app.Application
import android.content.Intent
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Exercise the actual model, controller, service and offline resolver together. */
class EditionPlaybackTest {
    @Test fun editionSwitchKeepsPassagePauseIntentAndCurrentAudioOnFailure() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        context.stopService(Intent(context, PlaybackService::class.java)); delay(300)
        val store = ListenerStore.get(context); store.clear(); Credentials(context).clear()
        val rate = 22050; val dataBytes = rate * 12 * 2
        val wav = ByteBuffer.allocate(44 + dataBytes).order(ByteOrder.LITTLE_ENDIAN)
        wav.put("RIFF".toByteArray()).putInt(36 + dataBytes).put("WAVEfmt ".toByteArray()).putInt(16)
        wav.putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16).put("data".toByteArray()).putInt(dataBytes)
        val tone = File(context.cacheDir, "edition-fixture.wav").apply { writeBytes(wav.array()) }
        val checksum = OfflineAudio.digest(tone)
        val original = Chapter("one", 1, "One", "a".repeat(64), 12.0, checksum)
        val target = original.copy(assembly = "b".repeat(64))
        val book = Book("fixture", "Fixture", "Author", mapOf("v3" to listOf(original), "flash" to listOf(target)))
        val account = "c".repeat(64)
        store.library(JSONObject("""{"accountKey":"$account","books":[{"id":"fixture","title":"Fixture","author":"Author","defaultEdition":"v3","editions":{"v3":{"chapters":[${Selection(book.id, book.title, "v3", original).json().getJSONObject("chapter")}]},"flash":{"chapters":[${Selection(book.id, book.title, "flash", target).json().getJSONObject("chapter")}]}}}]}"""))
        val cached = File(context.filesDir, "offline-audio/$account/$checksum.mp3").apply { parentFile!!.mkdirs() }
        tone.copyTo(cached, overwrite = true)
        fun text(assembly: String, boundary: Int): JSONObject = JSONObject().put("assembly", assembly).put("source", "same-source").put("passages", JSONArray()
            .put(JSONObject().put("id", "first").put("start", 0).put("end", boundary).put("text", "First passage.\n\n"))
            .put(JSONObject().put("id", "second").put("start", boundary).put("end", 12).put("text", "Second passage.")))
        store.reading(original.assembly, text(original.assembly, 4)); store.reading(target.assembly, text(target.assembly, 8))
        val models = ViewModelStore()
        val model = withContext(Dispatchers.Main) { ViewModelProvider(models, ViewModelProvider.AndroidViewModelFactory.getInstance(context.applicationContext as Application))[ListenerViewModel::class.java] }
        suspend fun await(label: String, condition: () -> Boolean) {
            repeat(150) { if (withContext(Dispatchers.Main) { condition() }) return; delay(100) }
            fail("Timed out: $label · position=${model.state.value.position} playing=${model.state.value.playing} · ${model.state.value.message}")
        }
        try {
            await("controller") { model.controller != null }
            withContext(Dispatchers.Main) { model.play(book, "v3", original) }
            await("playing original") { model.state.value.playing }
            withContext(Dispatchers.Main) { model.seek(6.0); model.toggle() }
            await("paused original at source time") { !model.state.value.playing && kotlin.math.abs(model.state.value.position - 6.0) < .2 }
            val jumps = store.recentJumps(book.id).size
            withContext(Dispatchers.Main) { model.switchEdition("flash") }
            await("mapped paused edition") { model.state.value.selection?.edition == "flash" && !model.state.value.switchingEdition && kotlin.math.abs(model.state.value.position - 9.0) < .2 }
            withContext(Dispatchers.Main) { assertFalse(model.controller!!.playWhenReady) }
            assertEquals(jumps, store.recentJumps(book.id).size)
            assertEquals("flash", store.latest(listOf(book))?.edition)
            assertEquals(9.0, store.position(Selection(book.id, book.title, "flash", target)), .2)
            withContext(Dispatchers.Main) { model.toggle() }
            await("playing target") { model.state.value.playing }
            withContext(Dispatchers.Main) { model.switchEdition("v3") }
            await("playing after edition return") { model.state.value.selection?.edition == "v3" && model.state.value.playing && !model.state.value.switchingEdition }
            store.reading(target.assembly, text(target.assembly, 8).put("passages", JSONArray().put(JSONObject().put("id", "different").put("start", 0).put("end", 12).put("text", "Different source."))))
            withContext(Dispatchers.Main) { model.switchEdition("flash") }
            await("unavailable passage leaves current recording") { !model.state.value.switchingEdition && model.state.value.message.contains("unavailable") }
            assertEquals("v3", model.state.value.selection?.edition)
            withContext(Dispatchers.Main) { assertTrue(model.controller!!.playWhenReady) }
        } finally {
            withContext(Dispatchers.Main) { model.controller?.stop(); models.clear() }
            context.stopService(Intent(context, PlaybackService::class.java)); delay(300)
            OfflineAudio(context).clear(); store.clear(); tone.delete()
        }
    }
}
