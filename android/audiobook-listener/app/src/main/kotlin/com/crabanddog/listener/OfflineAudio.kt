package com.crabanddog.listener

import android.content.Context
import android.net.Uri
import androidx.work.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import org.json.JSONObject

class OfflineAudio(private val context: Context, private val http: OkHttpClient = client) {
    val prefs = context.getSharedPreferences("offline-audio", Context.MODE_PRIVATE)
    private val root get() = File(context.filesDir, "offline-audio")
    private fun account(): String? = ListenerStore.get(context).library()?.optString("accountKey")?.takeIf { Regex("[a-f0-9]{64}").matches(it) }
    private fun directory(): File? = account()?.let { File(root, it) }
    fun enabled() = prefs.getBoolean("enabled", true)
    fun wifiOnly() = prefs.getBoolean("wifi", true)
    fun limitGb() = prefs.getInt("limit-gb", 8).coerceIn(2, 32)
    fun status() = prefs.getString("status", "Choose a book here, or download all available audio.").orEmpty()
    private fun selectionKey(story: String, edition: String) = "selection:${account()}:$story:$edition"
    private fun selectionKey(book: Book, edition: String) = selectionKey(book.id, edition)
    private fun pauseKey(story: String, edition: String) = "paused:${account()}:$story:$edition"
    fun selected(book: Book, edition: String): Boolean = !paused(book.id, edition) && prefs.getBoolean(selectionKey(book, edition), book.autoDownload && edition == "qwen")
    fun select(book: Book, edition: String, selected: Boolean) {
        prefs.edit().putBoolean(selectionKey(book, edition), selected).putBoolean(pauseKey(book.id, edition), !selected).apply()
    }
    fun selections(books: List<Book>) = downloadSelections(books, ::selected)
    fun downloadAll(books: List<Book>) {
        val edit = prefs.edit()
        books.forEach { book -> book.editions.keys.forEach { edit.putBoolean(selectionKey(book, it), true).putBoolean(pauseKey(book.id, it), false) } }
        edit.apply()
        resume()
    }
    fun resume() { prefs.edit().putBoolean("enabled", true).apply(); schedule(context, restart = true) }
    fun pause() {
        prefs.edit().putBoolean("enabled", false).apply()
        WorkManager.getInstance(context).cancelAllWorkByTag("listener-download")
        status("Downloads paused. Finished chapters remain available offline.")
    }
    fun progress(ready: Int, total: Int, bytes: Long = 0, size: Long = 0) {
        prefs.edit().putInt("ready", ready).putInt("total", total).putLong("bytes", bytes).putLong("size", size).apply()
    }
    fun savedCount(chapters: List<Chapter>): Int = chapters.count { chapter ->
        Regex("[a-f0-9]{64}").matches(chapter.checksum) && directory()?.let { File(it, "${chapter.checksum}.mp3").isFile } == true
    }
    fun status(value: String) { prefs.edit().putString("status", value).apply() }
    fun clear() {
        pause(); synchronized(fileLock) { root.deleteRecursively() }
        val edit = prefs.edit().remove("retry-chapters")
        prefs.all.keys.filter { it.startsWith("ready:") || it.startsWith("progress:") }.forEach { edit.remove(it) }
        edit.apply(); progress(0, 0); status("Downloaded audio cleared. Downloads are paused.")
    }
    private fun filesKey(story: String) = "files:${account()}:$story"
    private fun ownedFiles(story: String): JSONObject = runCatching { JSONObject(prefs.getString(filesKey(story), "{}").orEmpty()) }.getOrDefault(JSONObject())
    private fun rememberFile(selection: Selection) { val files = ownedFiles(selection.story).put(selection.chapter.assembly, selection.chapter.checksum); check(prefs.edit().putString(filesKey(selection.story), files.toString()).commit()) }
    fun clearBook(book: Book, books: List<Book>) {
        val account = account() ?: return
        val targetKey = "files:$account:${book.id}"
        val historical = JSONObject(prefs.getString(targetKey, "{}").orEmpty())
        val all = book.editions.values.flatten() + historical.keys().asSequence().map { Chapter(it, 0, "", it, 0.0, historical.getString(it)) }.toList()
        val other = books.filter { it.id != book.id }.flatMap { it.editions.values.flatten() }
        val otherFiles = prefs.all.keys.filter { it.startsWith("files:$account:") && it != targetKey }.map { key -> JSONObject(prefs.getString(key, "{}").orEmpty()) }
        val keepFiles = other.map { it.checksum }.toSet() + otherFiles.flatMap { obj -> obj.keys().asSequence().map { obj.getString(it) }.toList() }
        val keepAssemblies = other.map { it.assembly }.toSet() + otherFiles.flatMap { it.keys().asSequence().toList() }
        val edit = prefs.edit().remove(targetKey)
        book.editions.keys.forEach { edition -> edit.putBoolean("selection:$account:${book.id}:$edition", false).putBoolean("paused:$account:${book.id}:$edition", true) }
        prefs.all.keys.filter { it.startsWith("selection:$account:${book.id}:") || it.startsWith("paused:$account:${book.id}:") }.forEach { key -> edit.putBoolean(key, key.startsWith("paused:")) }
        all.filter { it.assembly !in keepAssemblies }.forEach { edit.remove("ready:${it.assembly}") }
        prefs.all.keys.filter { it.startsWith("progress:${book.id}:") }.forEach { edit.remove(it) }
        check(edit.commit())
        synchronized(fileLock) {
            val dir = File(root, account)
            all.filter { Regex("[a-f0-9]{64}").matches(it.checksum) && it.checksum !in keepFiles }.forEach { chapter ->
                File(dir, "${chapter.checksum}.mp3").delete(); File(dir, "${chapter.checksum}.part").delete()
            }
        }
        status("Downloads cleared for ${book.title}. Your listening place is kept.")
    }
    fun requested(story: String, edition: String) = prefs.getBoolean(selectionKey(story, edition), false)
    fun paused(story: String, edition: String) = prefs.getBoolean(pauseKey(story, edition), false)
    fun request(story: String, edition: String) {
        prefs.edit().putBoolean(selectionKey(story, edition), true).putBoolean(pauseKey(story, edition), false).apply()
        progress(story, edition, "Waiting for ${if (wifiOnly()) "Wi-Fi" else "a connection"}")
        resume()
    }
    fun pause(story: String, edition: String) {
        prefs.edit().putBoolean(selectionKey(story, edition), false).putBoolean(pauseKey(story, edition), true).apply()
        progress(story, edition, "Downloads paused")
    }
    fun ready(chapter: Chapter) = chapter.checksum.isNotEmpty() && prefs.getBoolean("ready:${chapter.assembly}", false) && directory()?.let { File(it, "${chapter.checksum}.mp3").isFile } == true
    fun progress(story: String, edition: String): JSONObject = runCatching { JSONObject(prefs.getString("progress:$story:$edition", "{}").orEmpty()) }.getOrDefault(JSONObject())
    fun progress(story: String, edition: String, status: String, bytes: Long = 0, totalBytes: Long = -1, chapter: String = "", retry: Boolean = false) {
        prefs.edit().putString("progress:$story:$edition", JSONObject().put("status", status).put("bytes", bytes).put("totalBytes", totalBytes).put("chapter", chapter).put("retry", retry).toString()).apply()
    }
    fun resolve(uri: Uri): Uri {
        if (uri.scheme != "https" || uri.host != Uri.parse(BuildConfig.LISTENER_URL).host) return uri
        val match = Regex("/api/listener/stories/([a-zA-Z0-9_-]+)/([a-zA-Z0-9_-]+)/audio/([a-f0-9]{64})").matchEntire(uri.path.orEmpty()) ?: return uri
        val books = ListenerStore.get(context).library()?.let(::booksFromJson) ?: return uri
        val chapter = books.find { it.id == match.groupValues[1] }?.editions?.get(match.groupValues[2])?.find { it.assembly == match.groupValues[3] } ?: ownedFiles(match.groupValues[1]).optString(match.groupValues[3]).takeIf { Regex("[a-f0-9]{64}").matches(it) }?.let { checksum -> Chapter("", 0, "", match.groupValues[3], 0.0, checksum) } ?: return uri
        return file(chapter)?.let(Uri::fromFile) ?: uri
    }
    fun file(chapter: Chapter): File? {
        if (!Regex("[a-f0-9]{64}").matches(chapter.checksum)) return null
        val dir = directory() ?: return null
        val file = File(dir, "${chapter.checksum}.mp3")
        if (!file.isFile) { prefs.edit().remove("ready:${chapter.assembly}").apply(); return null }
        if (digest(file) != chapter.checksum) { file.delete(); prefs.edit().remove("ready:${chapter.assembly}").apply(); return null }
        return file
    }
    suspend fun download(token: String, selection: Selection, onProgress: (Long, Long) -> Unit = { _, _ -> }): Boolean = withContext(Dispatchers.IO) {
        val chapter = selection.chapter
        if (file(chapter) != null) { rememberFile(selection); return@withContext true }
        check(Regex("[a-f0-9]{64}").matches(chapter.checksum)) { "Chapter checksum is missing" }
        val dir = directory() ?: error("Sync your library first")
        rememberFile(selection)
        check(dir.mkdirs() || dir.isDirectory)
        val remaining = limitGb().toLong() * 1024 * 1024 * 1024 - root.walkTopDown().filter { it.isFile && it.extension != "part" }.sumOf { it.length() }
        if (remaining <= 0 || dir.usableSpace < 512L * 1024 * 1024) return@withContext false
        val temp = File(dir, "${chapter.checksum}.part")
        try {
            val request = Request.Builder().url("${ListenerApi.BASE}/stories/${selection.story}/${selection.edition}/audio/${chapter.assembly}").header("Authorization", "Bearer $token").build()
            http.newCall(request).execute().use { response ->
                check(response.isSuccessful) { "Audio download failed (${response.code})" }
                val body = response.body ?: error("Audio download was empty")
                body.byteStream().use { input -> temp.outputStream().use { output ->
                    val buffer = ByteArray(65536); var total = 0L; var reportedAt = 0L
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        check(Credentials(context).read() == token && enabled() && !paused(selection.story, selection.edition)) { "Download cancelled" }
                        val count = input.read(buffer); if (count < 0) break
                        total += count; if (total > remaining) return@withContext false
                        check(total <= 250_000_000 && dir.usableSpace > 256L * 1024 * 1024) { "Audio download exceeds available storage" }
                        output.write(buffer, 0, count)
                        val now = System.currentTimeMillis()
                        if (now - reportedAt >= 500) {
                            onProgress(total, body.contentLength())
                            progress(selection.story, selection.edition, "Downloading audio", total, body.contentLength(), chapter.title)
                            reportedAt = now
                        }
                    }
                    output.fd.sync()
                } }
            }
            check(digest(temp) == chapter.checksum) { "Audio checksum mismatch" }
            synchronized(fileLock) {
                check(Credentials(context).read() == token && enabled() && !paused(selection.story, selection.edition)) { "Download cancelled" }
                check(temp.renameTo(File(dir, "${chapter.checksum}.mp3"))) { "Could not save audio" }
            }
            true
        } finally { temp.delete() }
    }
    companion object {
        private val fileLock = Any()
        private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).callTimeout(5, TimeUnit.MINUTES).build()
        fun digest(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input -> val buffer = ByteArray(65536); while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) } }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }
        fun schedule(context: Context, restart: Boolean = false) {
            val audio = OfflineAudio(context); val manager = WorkManager.getInstance(context)
            if (!audio.enabled() || Credentials(context).read() == null) { manager.cancelAllWorkByTag("listener-download"); return }
            val constraints = Constraints.Builder().setRequiredNetworkType(if (audio.wifiOnly()) NetworkType.UNMETERED else NetworkType.CONNECTED).setRequiresStorageNotLow(true).build()
            manager.enqueueUniquePeriodicWork("listener-download-periodic", ExistingPeriodicWorkPolicy.UPDATE,
                PeriodicWorkRequestBuilder<AudioDownloadWorker>(15, TimeUnit.MINUTES).setConstraints(constraints).addTag("listener-download").build())
            if (restart) audio.status(if (audio.wifiOnly()) "Queued. Waiting for Wi-Fi if it is unavailable." else "Queued. Downloads can use Wi-Fi or mobile data.")
            manager.enqueueUniqueWork("listener-download-now", if (restart) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<AudioDownloadWorker>().setBackoffCriteria(BackoffPolicy.LINEAR, 10, TimeUnit.SECONDS).setConstraints(constraints).addTag("listener-download").build())
        }
    }
}

class AudioDownloadWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) { lock.withLock {
        val audio = OfflineAudio(applicationContext)
        val token = Credentials(applicationContext).read() ?: return@withLock Result.success()
        var current: Selection? = null
        if (!audio.enabled()) return@withLock Result.success()
        try {
            val api = ListenerApi(applicationContext); val store = ListenerStore.get(applicationContext)
            val library = api.call("/library")
            if (Credentials(applicationContext).read() != token || isStopped) return@withLock Result.success()
            store.library(library)
            val retryKeys = audio.prefs.getStringSet("retry-chapters", emptySet()).orEmpty()
            val books = booksFromJson(library)
            val chapters = audio.selections(books).sortedBy { it.key in retryKeys }
            val started = System.currentTimeMillis()
            var ready = 0
            val pendingRetries = retryKeys.intersect(chapters.map { it.key }.toSet()).toMutableSet()
            val result = downloadBatch(
                chapters = chapters,
                beforeChapter = { selection ->
                    if (isStopped || !audio.enabled() || Credentials(applicationContext).read() != token) throw CancellationException("Downloads paused")
                    current = selection
                    audio.status("Downloading ${selection.bookTitle}: ${selection.chapter.title}")
                    audio.progress(ready, chapters.size)
                },
                shouldSkip = { audio.paused(it.story, it.edition) },
                shouldYield = { System.currentTimeMillis() - started > 7 * 60 * 1000 },
                downloadAudio = { selection ->
                    val saved = audio.download(token, selection) { bytes, size -> audio.progress(ready, chapters.size, bytes, size) }
                    if (saved) {
                        audio.prefs.edit().putBoolean("ready:${selection.chapter.assembly}", true).apply()
                        audio.progress(selection.story, selection.edition, "Audio saved; checking reading text", chapter = selection.chapter.title)
                    } else audio.progress(selection.story, selection.edition, "Storage limit reached or storage is low")
                    saved
                },
                downloadText = { selection ->
                    val text = store.reading(selection.chapter.assembly) ?: api.call("/stories/${selection.story}/${selection.edition}/text/${selection.chapter.assembly}")
                    if (Credentials(applicationContext).read() != token || isStopped || !audio.enabled()) throw CancellationException("Downloads paused")
                    store.reading(selection.chapter.assembly, text)
                    pendingRetries.remove(selection.key)
                    audio.progress(selection.story, selection.edition, "Downloaded chapters are ready offline")
                },
                onUpdate = { progress ->
                    ready = progress.ready
                    pendingRetries.addAll(progress.failures.map { it.selection.key })
                    audio.prefs.edit().putStringSet("retry-chapters", pendingRetries.toSet()).apply()
                    audio.progress(progress.ready, progress.total)
                },
            )
            for ((edition, selections) in chapters.groupBy { it.story to it.edition }) {
                if (audio.paused(edition.first, edition.second)) continue
                val failures = result.failures.filter { it.selection in selections }
                if (failures.isNotEmpty()) {
                    val audioCount = failures.count { it.part == DownloadPart.AUDIO }
                    val textCount = failures.count { it.part == DownloadPart.TEXT }
                    audio.progress(edition.first, edition.second,
                        "Audio downloads failed: $audioCount. Reading text unavailable: $textCount. Saved audio can still play. " +
                            failures.joinToString("; ") { "${it.selection.chapter.title}: ${it.reason}" }, retry = true)
                } else if (result.stop == DownloadStop.FINISHED) {
                    audio.progress(edition.first, edition.second, "Downloaded chapters are ready offline")
                }
            }
            val audioFailures = result.failures.count { it.part == DownloadPart.AUDIO }
            val textFailures = result.failures.count { it.part == DownloadPart.TEXT }
            val issues = result.failures.joinToString("\n") { failure ->
                "${failure.selection.bookTitle} — ${failure.selection.chapter.title}: ${if (failure.part == DownloadPart.AUDIO) "audio" else "reading text"} failed (${failure.reason})."
            }
            val summary = "${result.ready} of ${result.total} audio chapters available offline." +
                (if (audioFailures > 0) " Audio downloads awaiting retry: $audioFailures." else "") +
                (if (textFailures > 0) " Reading text unavailable: $textFailures. Their audio is saved." else "")
            val ending = when (result.stop) {
                DownloadStop.STORAGE -> "Download paused: ${audio.limitGb()} GB limit or low storage. Increase the limit or clear downloads."
                DownloadStop.YIELD -> "Continuing remaining downloads shortly…"
                DownloadStop.FINISHED -> if (chapters.isEmpty()) "No audio selected. Choose a book or download all available audio." else summary
            }
            audio.status(ending + if (issues.isNotBlank()) "\n$issues" else "")
            if (result.stop == DownloadStop.STORAGE) Result.success()
            else if (result.stop == DownloadStop.YIELD || result.failures.isNotEmpty()) Result.retry()
            else Result.success()
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            current?.let {
                val status = when {
                    !audio.enabled() || audio.paused(it.story, it.edition) -> "Downloads paused"
                    e.message?.contains("checksum", ignoreCase = true) == true -> "Download could not be verified; will retry"
                    e.message?.contains("storage", ignoreCase = true) == true -> "Storage is low; free space to continue"
                    else -> "Connection interrupted; will retry"
                }
                audio.progress(it.story, it.edition, status)
            }
            if (audio.enabled() && Credentials(applicationContext).read() == token) {
                audio.status("Download interrupted: ${e.message ?: "connection unavailable"}. Use the download controls to retry now.")
            }
            Result.retry()
        }
    } }
    companion object { private val lock = Mutex() }
}
