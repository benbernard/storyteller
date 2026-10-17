package com.crabanddog.listener

import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.security.MessageDigest

class OfflineAudioTest {
    @Test fun downloadVerifiesIntegrityReportsBytesAndResolvesOffline() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val store = ListenerStore.get(context)
        val credentials = Credentials(context)
        val bytes = ByteArray(131072) { (it % 127).toByte() }
        val checksum = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val assembly = "a".repeat(64)
        val account = "b".repeat(64)
        val chapter = Chapter("one", 1, "One", assembly, 60.0, checksum)
        val selection = Selection("story", "Story", "flash", chapter)
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            assertTrue(chain.request().url.encodedPath.contains("/flash/audio/"))
            assertEquals("Bearer fixture-token", chain.request().header("Authorization"))
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK").body(bytes.toResponseBody()).build()
        }.build()
        val audio = OfflineAudio(context, client)
        try {
            audio.clear()
            audio.prefs.edit().putBoolean("enabled", true).commit()
            credentials.write("fixture-token")
            store.library(JSONObject("""{"accountKey":"$account","books":[{"id":"story","title":"Story","editions":{"flash":{"chapters":[{"id":"one","sequence":1,"title":"One","assembly":"$assembly","duration":60,"checksum":"$checksum"}]}}}]}"""))
            var reported = 0L
            assertTrue(audio.download("fixture-token", selection) { count, size -> reported = count; assertEquals(bytes.size.toLong(), size) })
            assertTrue(reported > 0)
            val file = audio.file(chapter)!!
            assertArrayEquals(bytes, file.readBytes())
            val remote = Uri.parse("${ListenerApi.BASE}/stories/story/flash/audio/$assembly")
            assertEquals(Uri.fromFile(file), audio.resolve(remote))
            file.writeText("corrupt")
            assertNull(audio.file(chapter))
            assertFalse(file.exists())
            try {
                audio.download("fixture-token", selection.copy(chapter = chapter.copy(checksum = "c".repeat(64))))
                fail("A mismatched checksum must not become playable")
            } catch (expected: IllegalStateException) { assertEquals("Audio checksum mismatch", expected.message) }
            assertTrue(File(context.filesDir, "offline-audio/$account").listFiles().orEmpty().none { it.extension == "part" || it.extension == "mp3" })
        } finally {
            credentials.clear(); audio.clear(); audio.prefs.edit().clear().commit(); store.clear()
        }
    }
}
