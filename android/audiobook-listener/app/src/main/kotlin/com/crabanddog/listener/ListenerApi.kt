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

class ListenerApi(private val context: Context, private val client: OkHttpClient = OkHttpClient()) {
    private val credentials = Credentials(context)
    private val store = ListenerStore.get(context)
    companion object { val BASE = BuildConfig.LISTENER_URL + "/api/listener"; private val syncLock = Mutex() }
    suspend fun call(path: String, body: JSONObject? = null, authenticated: Boolean = true): JSONObject = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(BASE + path)
        if (authenticated) request.header("Authorization", "Bearer ${credentials.read() ?: error("Sign in first.")}")
        if (body != null) request.post(body.toString().toRequestBody("application/json".toMediaType()))
        client.newCall(request.build()).execute().use { response ->
            val result = JSONObject(response.body?.string() ?: "{}")
            if (!response.isSuccessful) error(result.optString("error", "Request failed (${response.code})."))
            result
        }
    }
    suspend fun cover(story: String): ByteArray = withContext(Dispatchers.IO) {
        require(Regex("[a-zA-Z0-9_-]+").matches(story))
        val account = store.library()?.optString("accountKey")?.takeIf { Regex("[a-f0-9]{64}").matches(it) }
        val cached = account?.let { java.io.File(context.filesDir, "listener-covers/$it/$story") }
        if (cached?.isFile == true && System.currentTimeMillis() - cached.lastModified() < 3600000) return@withContext cached.readBytes()
        val request = Request.Builder().url("$BASE/stories/$story/cover")
            .header("Authorization", "Bearer ${credentials.read() ?: error("Sign in first.")}").build()
        try {
            client.newCall(request).execute().use { response ->
                check(response.isSuccessful) { "Cover unavailable" }
                val bytes = response.body?.bytes() ?: error("Cover unavailable")
                if (cached != null) runCatching { cached.parentFile?.mkdirs(); val file = android.util.AtomicFile(cached); val output = file.startWrite(); try { output.write(bytes); file.finishWrite(output) } catch (error: Exception) { file.failWrite(output); throw error } }
                bytes
            }
        } catch (error: Exception) { if (cached?.isFile == true) cached.readBytes() else throw error }
    }
    suspend fun checkAudio(selection: Selection) = withContext(Dispatchers.IO) {
        if (OfflineAudio(context).file(selection.chapter) != null) return@withContext
        val request = Request.Builder().url("$BASE/stories/${selection.story}/${selection.edition}/audio/${selection.chapter.assembly}").head()
            .header("Authorization", "Bearer ${credentials.read() ?: error("Sign in first.")}").build()
        client.newCall(request).execute().use { check(it.isSuccessful) { "Audio is unavailable. Your current place is kept." } }
    }
    suspend fun sync() = syncLock.withLock {
        while (true) {
            val batch = store.outbox(); if (batch.isEmpty()) break
            for (entry in batch) {
                val body = JSONObject(entry.getJSONObject("body").toString()); body.remove("_localFrom"); body.remove("_localIssue")
                call(entry.getString("path"), body)
                store.acknowledged(body.getString("eventId"))
            }
        }
    }
}
