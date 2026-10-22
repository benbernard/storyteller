package com.crabanddog.listener

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

class CoverCacheTest {
    @Test fun coversStayAvailableOfflineAndIsolatedByAccount() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val store = ListenerStore.get(context); val credentials = Credentials(context)
        var requests = 0; var available = true
        val bytes = "fictional cover bytes".toByteArray()
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            requests++
            assertEquals("Bearer fixture-cover-token", chain.request().header("Authorization"))
            if (!available) throw java.io.IOException("offline fixture")
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK").body(bytes.toResponseBody()).build()
        }.build()
        try {
            store.clear(); credentials.write("fixture-cover-token")
            store.library(JSONObject().put("accountKey", "a".repeat(64)))
            val api = ListenerApi(context, client)
            assertArrayEquals(bytes, api.cover("fictional-book"))
            assertArrayEquals(bytes, api.cover("fictional-book")); assertEquals(1, requests)
            val cached = File(context.filesDir, "listener-covers/${"a".repeat(64)}/fictional-book")
            cached.setLastModified(System.currentTimeMillis() - 7200000)
            available = false
            assertArrayEquals(bytes, api.cover("fictional-book")); assertEquals(2, requests)
            store.library(JSONObject().put("accountKey", "b".repeat(64)))
            try { api.cover("fictional-book"); fail("Another account must not receive the first account’s cover") } catch (_: java.io.IOException) { }
            store.clear(); assertFalse(File(context.filesDir, "listener-covers").exists())
        } finally { credentials.clear(); store.clear() }
    }
}
