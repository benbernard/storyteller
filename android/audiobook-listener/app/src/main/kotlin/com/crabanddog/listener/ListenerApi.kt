package com.crabanddog.listener

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

class ListenerApi(context: Context) {
    private val credentials = Credentials(context)
    private val store = ListenerStore.get(context)
    private val client = OkHttpClient()
    companion object { val BASE = BuildConfig.LISTENER_URL + "/api/listener"; private val syncLock = Mutex() }
    suspend fun call(path: String, body: JSONObject? = null, authenticated: Boolean = true): JSONObject = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(BASE + path)
        if (authenticated) request.header("Authorization", "Bearer ${credentials.read() ?: error("Connect your account first.")}")
        if (body != null) request.post(body.toString().toRequestBody("application/json".toMediaType()))
        client.newCall(request.build()).execute().use { response ->
            val result = JSONObject(response.body?.string() ?: "{}")
            if (!response.isSuccessful) error(result.optString("error", "Request failed (${response.code})."))
            result
        }
    }
    suspend fun cover(story: String): ByteArray = withContext(Dispatchers.IO) {
        require(Regex("rr-\\d+").matches(story))
        val request = Request.Builder().url("$BASE/stories/$story/cover")
            .header("Authorization", "Bearer ${credentials.read() ?: error("Connect your account first.")}").build()
        client.newCall(request).execute().use { response ->
            check(response.isSuccessful) { "Cover unavailable" }
            response.body?.bytes() ?: error("Cover unavailable")
        }
    }
    suspend fun sync() = syncLock.withLock {
        for (entry in store.outbox()) {
            call(entry.getString("path"), entry.getJSONObject("body"))
            store.acknowledged(entry.getJSONObject("body").getString("eventId"))
        }
    }
}
