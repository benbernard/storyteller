package com.crabanddog.listener

import android.app.Application
import android.content.ComponentName
import android.os.Bundle
import android.util.Base64
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.security.SecureRandom

class ListenerViewModel(app: Application) : AndroidViewModel(app) {
    private val api = ListenerApi(app)
    private val store = ListenerStore.get(app)
    private val credentials = Credentials(app)
    private val mutable = MutableStateFlow(ListenerUiState(connected = credentials.read() != null, selection = store.selection(), speed = store.speed(), includeAuthorNotes = store.includeAuthorNotes()))
    val state = mutable.asStateFlow()
    var controller: MediaController? = null
        private set
    private var pairing = false
    private val future = MediaController.Builder(app, SessionToken(app, ComponentName(app, PlaybackService::class.java))).buildAsync()
    init {
        store.library()?.let { load(it) }
        future.addListener({
            runCatching {
                controller = future.get()
                controller?.addListener(object : Player.Listener {
                    override fun onPlayerError(error: androidx.media3.common.PlaybackException) { message("Playback stopped. Check your connection, then tap Play to retry.") }
                    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                        mediaItem?.mediaMetadata?.extras?.getString("selection")?.let { text ->
                            runCatching { selectionFromJson(JSONObject(text)) }.getOrNull()?.let { selected -> select(selected) }
                        }
                    }
                })
                controller?.currentMediaItem?.mediaMetadata?.extras?.getString("selection")?.let { text -> runCatching { selectionFromJson(JSONObject(text)) }.getOrNull()?.let { select(it) } }
                mutable.value.selection?.let { loadReading(it) }
            }.onFailure { message("Could not start the audio player.") }
        }, ContextCompat.getMainExecutor(app))
        if (mutable.value.connected) { OfflineAudio.schedule(app); refresh() }
        viewModelScope.launch { while (true) { controller?.let { p ->
            val state = mutable.value
            val position = if (p.currentMediaItem != null) state.selection?.let { chapterView(it.chapter, state.reading, state.includeAuthorNotes).source(p.currentPosition.coerceAtLeast(0) / 1000.0) } ?: 0.0 else state.selection?.let { store.position(it) } ?: 0.0
            mutable.value = state.copy(playing = p.isPlaying, position = position, positions = store.positions(), undo = store.undo(), pending = store.outbox().count { it.optString("path") == "/issues" })
        }; delay(500) } }
    }
    private fun message(value: String) { mutable.value = mutable.value.copy(message = value) }
    fun connect(open: (String) -> Unit) {
        if (pairing) return
        pairing = true
        viewModelScope.launch {
            try {
                val secret = Base64.encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) }, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
                val pair = api.call("/pair/start", JSONObject().put("secret", secret), false)
                mutable.value = mutable.value.copy(pairCode = pair.getString("code"), message = "Approve this code in your browser, then return here.")
                open(pair.getString("url"))
                repeat(200) {
                    delay(3000)
                    val result = api.call("/pair/poll", JSONObject().put("secret", secret).put("code", pair.getString("code")), false)
                    if (result.has("token")) { credentials.write(result.getString("token")); mutable.value = mutable.value.copy(connected = true, pairCode = ""); refresh(); return@launch }
                }
                message("Connection expired. Tap Connect to try again.")
            } catch (e: Exception) { message(e.message ?: "Connection failed.") } finally { pairing = false }
        }
    }
    private fun load(data: JSONObject) {
        val remote = data.optJSONObject("state") ?: JSONObject()
        store.importProgress(remote.optJSONObject("positions") ?: JSONObject())
        val issues = remote.optJSONArray("issues")
        val books = booksFromJson(data)
        mutable.value = mutable.value.copy(books = books, positions = store.positions(), issues = (0 until (issues?.length() ?: 0)).map { issues!!.getJSONObject(it) },
            completed = remote.optJSONObject("completed")?.let { c -> c.keys().asSequence().filter { c.optBoolean(it) }.toSet() } ?: emptySet())
        if (controller?.currentMediaItem == null) {
            val latest = store.latestLocation()
            val known = store.latest(books)
            if (latest != null) {
                if (known != null && known.chapter.assembly == latest.optString("assembly")) select(known)
                else if (mutable.value.selection?.chapter?.assembly == latest.optString("assembly")) mutable.value.selection?.let { select(it) }
                else returnTo(latest)
            }
        }
    }
    private suspend fun loadCatalog() {
        val data = api.call("/catalog")
        val stories = data.getJSONArray("stories"); val jobs = data.getJSONArray("jobs")
        mutable.value = mutable.value.copy(catalog = (0 until stories.length()).map { stories.getJSONObject(it) }, jobs = (0 until jobs.length()).map { jobs.getJSONObject(it) })
    }
    fun follow(url: String, enabled: Boolean, mode: String) { viewModelScope.launch {
        try { api.call("/follow", JSONObject().put("url", url).put("enabled", enabled).put("mode", mode).put("buffer", 5).put("intervalHours", 6)); loadCatalog(); message(if (enabled) "Story queued for automatic chapter checks." else "Automatic checks paused.") }
        catch (e: Exception) { message(e.message ?: "Could not update this story.") }
    } }
    fun check(story: String) { viewModelScope.launch { try { api.call("/check", JSONObject().put("story", story)); loadCatalog() } catch (e: Exception) { message(e.message ?: "Could not check this story.") } } }
    fun job(id: String, action: String) { viewModelScope.launch { try { api.call("/jobs", JSONObject().put("id", id).put("action", action)); loadCatalog() } catch (e: Exception) { message(e.message ?: "Could not update the job.") } } }
    fun audio(story: String, enabled: Boolean) { viewModelScope.launch {
        if (story in mutable.value.updatingStories) return@launch
        mutable.value = mutable.value.copy(updatingStories = mutable.value.updatingStories + story, storyErrors = mutable.value.storyErrors - story)
        try {
            api.call("/audio", JSONObject().put("story", story).put("enabled", enabled))
            pollLibrary()
        } catch (e: Exception) { mutable.value = mutable.value.copy(storyErrors = mutable.value.storyErrors + (story to (e.message ?: "Could not update audiobook settings. Try again."))) }
        finally { mutable.value = mutable.value.copy(updatingStories = mutable.value.updatingStories - story) }
    } }
    suspend fun pollLibrary() {
        if (!mutable.value.connected || mutable.value.loading) return
        val data = api.call("/library")
        val changed = mutable.value.books != booksFromJson(data)
        store.library(data); load(data); loadCatalog()
        if (changed) OfflineAudio.schedule(getApplication())
    }
    suspend fun poll() { runCatching { pollLibrary() } }
    fun disconnect() { viewModelScope.launch {
        controller?.run { stop(); clearMediaItems() }
        runCatching { api.sync(); api.call("/devices/revoke", JSONObject()) }
        credentials.clear(); androidx.work.WorkManager.getInstance(getApplication()).cancelAllWorkByTag("listener-download")
        OfflineAudio(getApplication()).let { audio ->
            audio.clear()
            val edit = audio.prefs.edit().remove("requested")
            audio.prefs.all.keys.filter { it.startsWith("paused:") || it.startsWith("selection:") }.forEach { edit.remove(it) }
            edit.apply()
        }
        store.clear(); mutable.value = ListenerUiState(message = "Disconnected on this phone.")
    } }
    fun refresh() { viewModelScope.launch {
        mutable.value = mutable.value.copy(loading = true)
        try { api.sync(); val data = api.call("/library"); store.library(data); OfflineAudio.schedule(getApplication()); load(data); loadCatalog(); message("Your progress is synced.") }
        catch (e: Exception) { message("${e.message ?: "Offline."} Progress and issues stay saved on this phone.") }
        finally { mutable.value = mutable.value.copy(loading = false) }
    } }
    private fun select(selected: Selection) {
        store.select(selected)
        mutable.value = mutable.value.copy(selection = selected, position = store.position(selected), undo = store.undo())
        loadReading(selected)
    }
    private fun loadReading(selected: Selection) {
        val cached = store.reading(selected.chapter.assembly)?.let { runCatching { readingFromJson(it) }.getOrNull() }
        mutable.value = mutable.value.copy(reading = cached)
        viewModelScope.launch {
            try {
                val data = api.call("/stories/${selected.story}/${selected.edition}/text/${selected.chapter.assembly}")
                store.reading(selected.chapter.assembly, data)
                if (mutable.value.selection?.chapter?.assembly == selected.chapter.assembly) mutable.value = mutable.value.copy(reading = readingFromJson(data))
            } catch (e: Exception) { if (cached == null) message("Passages could not load. Sync to retry.") }
        }
    }
    fun play(book: Book, edition: String, chapter: Chapter) { prepare(Selection(book.id, book.title, edition, chapter), null, true, true) }
    private fun prepare(selected: Selection, seconds: Double?, autoplay: Boolean, recordJump: Boolean = false) {
        val p = controller ?: return message("Player is starting. Try again shortly.")
        val previous = mutable.value.selection?.let { old -> old.location(undoPosition(old.chapter, mutable.value.reading, mutable.value.includeAuthorNotes, mutable.value.position)) }
        val chapters = mutable.value.books.find { it.id == selected.story }?.editions?.get(selected.edition)?.takeIf { list -> list.any { it.assembly == selected.chapter.assembly } } ?: listOf(selected.chapter)
        val items = chapters.map { c ->
            val s = Selection(selected.story, selected.bookTitle, selected.edition, c)
            MediaItem.Builder().setMediaId(c.assembly).setUri("${ListenerApi.BASE}/stories/${s.story}/${s.edition}/audio/${c.assembly}")
                .setMediaMetadata(MediaMetadata.Builder().setTitle(c.title).setArtist(s.bookTitle).setAlbumTitle("${editionName(s.edition)} edition")
                    .setExtras(Bundle().apply { putString("selection", s.json().toString()) }).build()).build()
        }
        val position = (seconds ?: store.position(selected)).coerceIn(0.0, selected.chapter.duration)
        p.pause(); select(selected)
        val view = chapterView(selected.chapter, mutable.value.reading, mutable.value.includeAuthorNotes)
        val sourcePosition = view.source(view.position(position))
        if (recordJump && previous != null && (previous.optString("assembly") != selected.chapter.assembly || kotlin.math.abs(previous.optDouble("seconds") - sourcePosition) > .001)) {
            store.saveProgress(selected, sourcePosition, reason = "chapter", from = previous)
            mutable.value = mutable.value.copy(undo = previous)
        }
        p.setMediaItems(items, chapters.indexOfFirst { it.assembly == selected.chapter.assembly }, (view.position(position) * 1000).toLong()); p.prepare()
        mutable.value = mutable.value.copy(position = position)
        if (autoplay) p.play()
    }
    fun toggle() {
        val p = controller ?: return
        if (p.currentMediaItem == null) {
            val s = mutable.value.selection ?: return
            val book = mutable.value.books.find { it.id == s.story } ?: return
            val chapter = book.editions[s.edition]?.find { it.id == s.chapter.id } ?: return
            play(book, s.edition, chapter)
        } else if (p.isPlaying) p.pause() else { if (p.playbackState == Player.STATE_IDLE) p.prepare(); p.play() }
    }
    fun seek(seconds: Double) { move(seconds, "seek") }
    fun skip(seconds: Int) {
        val p = controller ?: return
        if (p.currentMediaItem == null) mutable.value.selection?.let { prepare(it, null, false) }
        if (seconds < 0) p.seekBack() else p.seekForward()
    }
    fun passage(seconds: Double) { move(seconds, "passage") }
    private fun move(seconds: Double, reason: String) {
        val selected = mutable.value.selection ?: return
        val from = selected.location(undoPosition(selected.chapter, mutable.value.reading, mutable.value.includeAuthorNotes, mutable.value.position))
        val view = chapterView(selected.chapter, mutable.value.reading, mutable.value.includeAuthorNotes)
        val target = view.source(view.position(seconds))
        if (controller?.currentMediaItem == null) prepare(selected, target, false) else controller?.seekTo((view.position(target) * 1000).toLong())
        store.saveProgress(selected, target, reason = reason, from = from)
        mutable.value = mutable.value.copy(position = target, undo = from)
    }
    fun returnTo(location: JSONObject) {
        viewModelScope.launch {
            try {
                val book = mutable.value.books.find { it.id == location.getString("story") } ?: error("Story is unavailable.")
                val edition = location.getString("edition")
                val assembly = location.getString("assembly")
                val chapter = book.editions[edition]?.find { it.assembly == assembly } ?: api.call("/stories/${book.id}/$edition/text/$assembly").let { Chapter(it.getString("chapterId"), location.optInt("chapter", location.optInt("sequence", 0)), it.getString("title"), assembly, it.getDouble("duration")) }
                val selected = Selection(book.id, book.title, edition, chapter)
                val reading = store.reading(assembly)?.let { runCatching { readingFromJson(it) }.getOrNull() }
                val target = undoPosition(chapter, reading, mutable.value.includeAuthorNotes, location.getDouble("seconds"))
                if (controller == null) select(selected) else prepare(selected, target, false, true)
            } catch (e: Exception) { message(e.message ?: "Could not restore this location.") }
        }
    }
    fun history(earlier: Boolean = false) { viewModelScope.launch {
        try {
            api.sync()
            val page = api.call("/history" + if (earlier && mutable.value.historyBefore != null) "?before=${mutable.value.historyBefore}" else "")
            val entries = page.getJSONArray("entries")
            mutable.value = mutable.value.copy(history = (if (earlier) mutable.value.history else emptyList()) + (0 until entries.length()).map { entries.getJSONObject(it) }, historyBefore = if (page.isNull("before")) null else page.getLong("before"))
        } catch (e: Exception) { message("History could not sync. Every location is retained on this phone.") }
    } }

    fun speed(value: Float) { store.speed(value); controller?.setPlaybackSpeed(value); mutable.value = mutable.value.copy(speed = value) }
    fun includeAuthorNotes(value: Boolean) { store.includeAuthorNotes(value); mutable.value = mutable.value.copy(includeAuthorNotes = value) }
    fun markIssue(selection: Selection, seconds: Double, kind: String, note: String) {
        store.issue(selection, seconds, kind, note); message("Issue saved at ${formatTime(seconds)}."); refresh()
    }
    fun finished() { mutable.value.selection?.let { store.saveProgress(it, mutable.value.position, true); refresh() } }
    fun resolve(issue: JSONObject) { viewModelScope.launch { try { api.call("/issues/resolve", JSONObject().put("id", issue.getString("id")).put("resolved", issue.getString("status") == "open")); refresh() } catch (e: Exception) { message(e.message ?: "Could not update issue.") } } }
    fun characters(story: String) { viewModelScope.launch { try { val a = api.call("/stories/$story/characters").getJSONArray("characters"); mutable.value = mutable.value.copy(characters = (0 until a.length()).map { a.getJSONObject(it) }) } catch (e: Exception) { message(e.message ?: "Could not load characters.") } } }
    override fun onCleared() { MediaController.releaseFuture(future); super.onCleared() }
}
data class ListenerUiState(val connected: Boolean = false, val books: List<Book> = emptyList(), val selection: Selection? = null,
    val playing: Boolean = false, val position: Double = 0.0, val speed: Float = 1f, val loading: Boolean = false, val includeAuthorNotes: Boolean = true,
    val message: String = "", val pairCode: String = "", val issues: List<JSONObject> = emptyList(), val pending: Int = 0,
    val catalog: List<JSONObject> = emptyList(), val jobs: List<JSONObject> = emptyList(),
    val updatingStories: Set<String> = emptySet(), val storyErrors: Map<String, String> = emptyMap(),
    val reading: Reading? = null, val history: List<JSONObject> = emptyList(), val historyBefore: Long? = null, val undo: JSONObject? = null,
    val positions: List<JSONObject> = emptyList(), val completed: Set<String> = emptySet(), val characters: List<JSONObject> = emptyList())
