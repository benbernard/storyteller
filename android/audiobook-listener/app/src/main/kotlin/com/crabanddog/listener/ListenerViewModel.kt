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
    private val network = app.getSystemService(android.net.ConnectivityManager::class.java)
    private fun hasNetwork(): Boolean = network.getNetworkCapabilities(network.activeNetwork)?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    private val mutable = MutableStateFlow(ListenerUiState(offline = !hasNetwork(), connected = credentials.read() != null, selection = store.selection(), speed = store.speed(), includeAuthorNotes = store.includeAuthorNotes(), signInUrl = credentials.pending()?.takeIf { it.optLong("expiresAt") > System.currentTimeMillis() }?.let { "${BuildConfig.LISTENER_URL}/listen/signin?request=${it.getString("request")}" }.orEmpty(), history = store.cachedHistory(), catalog = jsonObjects(store.catalog()?.optJSONArray("stories")), jobs = jsonObjects(store.catalog()?.optJSONArray("jobs")), catalogReportedAt = store.catalogReportedAt()))
    val state = mutable.asStateFlow()
    var controller: MediaController? = null
        private set
    private var signInGeneration = 0
    private var navigationGeneration = 0
    private val future = MediaController.Builder(app, SessionToken(app, ComponentName(app, PlaybackService::class.java))).buildAsync()
    private val networkCallback = object : android.net.ConnectivityManager.NetworkCallback() {
        private fun changed() { viewModelScope.launch { mutable.value = mutable.value.copy(offline = !hasNetwork()) } }
        override fun onAvailable(network: android.net.Network) = changed()
        override fun onLost(network: android.net.Network) = changed()
        override fun onCapabilitiesChanged(network: android.net.Network, capabilities: android.net.NetworkCapabilities) = changed()
    }
    init {
        network.registerDefaultNetworkCallback(networkCallback)
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
            mutable.value = state.copy(playing = p.playWhenReady && p.playbackState != Player.STATE_ENDED, position = position, positions = store.positions(), undo = store.undo(), localJumps = state.selection?.let { store.recentJumps(it.story) }.orEmpty(), pending = store.pendingIssues().size)
        }; delay(500) } }
    }
    private fun message(value: String) { mutable.value = mutable.value.copy(message = value) }
    fun connect(open: (String) -> Unit) {
        if (mutable.value.signingIn || !hasNetwork()) return
        credentials.pending()?.let { previous -> viewModelScope.launch { runCatching { api.call("/signin/cancel", signInProof(previous), false) } } }; credentials.clearPending()
        val generation = ++signInGeneration
        mutable.value = mutable.value.copy(signingIn = true, message = "")
        viewModelScope.launch {
            val verifier = Base64.encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) }, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
            val nonce = Base64.encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) }, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
            try {
                val challenge = Base64.encodeToString(java.security.MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
                val started = api.call("/signin/start", JSONObject().put("challenge", challenge).put("state", nonce).put("redirectUri", "${BuildConfig.APPLICATION_ID}.signin://callback"), false)
                val attempt = JSONObject().put("request", started.getString("request")).put("state", nonce).put("verifier", verifier).put("expiresAt", started.getLong("expiresAt"))
                if (generation != signInGeneration) { runCatching { api.call("/signin/cancel", signInProof(attempt), false) }; return@launch }
                credentials.pending(attempt)
                mutable.value = mutable.value.copy(signInUrl = started.getString("url"), signingIn = false, message = "Finish signing in through your browser.")
                open(started.getString("url"))
            } catch (e: Exception) { if (generation == signInGeneration) { credentials.clearPending(); mutable.value = mutable.value.copy(signingIn = false, signInUrl = "", message = e.message ?: "Couldn’t open sign in. Try again.") } }
        }
    }
    private fun signInProof(attempt: JSONObject): JSONObject = JSONObject().put("request", attempt.getString("request")).put("state", attempt.getString("state")).put("verifier", attempt.getString("verifier"))
    fun cancelSignIn() {
        signInGeneration++
        val attempt = credentials.pending(); credentials.clearPending()
        mutable.value = mutable.value.copy(signingIn = false, signInUrl = "", message = "")
        if (attempt != null) viewModelScope.launch { runCatching { api.call("/signin/cancel", signInProof(attempt), false) } }
    }
    fun finishSignIn(uri: android.net.Uri) {
        if (uri.scheme != "${BuildConfig.APPLICATION_ID}.signin" || uri.host != "callback") return
        val attempt = credentials.pending() ?: return
        if (uri.getQueryParameter("state") != attempt.optString("state")) { message("This sign-in attempt does not match. Try signing in again."); return }
        if (attempt.optLong("expiresAt") <= System.currentTimeMillis()) { cancelSignIn(); message("Sign in timed out. Try again."); return }
        val code = uri.getQueryParameter("code")?.takeIf { Regex("[A-Za-z0-9_-]{43}").matches(it) } ?: return message("Couldn’t finish sign in. Try again.")
        val generation = signInGeneration
        mutable.value = mutable.value.copy(signingIn = true)
        viewModelScope.launch {
            try {
                val result = api.call("/signin/exchange", signInProof(attempt).put("code", code), false)
                if (generation != signInGeneration) { runCatching { api.call("/signin/cancel", signInProof(attempt), false) }; return@launch }
                val oldAccount = store.library()?.optString("accountKey").orEmpty()
                if (oldAccount.isNotEmpty() && oldAccount != result.getString("accountKey")) {
                    if (store.hasPending() || store.hasDrafts()) { runCatching { api.call("/signin/cancel", signInProof(attempt), false) }; error("Saved work belongs to your previous account. Sign in to that account and sync before switching.") }
                    controller?.run { stop(); clearMediaItems() }
                    OfflineAudio(getApplication()).clear(); store.clear()
                }
                credentials.write(result.getString("token")); credentials.clearPending()
                mutable.value = ListenerUiState(connected = true, speed = store.speed(), includeAuthorNotes = store.includeAuthorNotes())
                refresh()
            } catch (e: Exception) { if (generation == signInGeneration) mutable.value = mutable.value.copy(signingIn = false, message = e.message ?: "Couldn’t finish sign in. Try again.") }
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
        val data = api.call("/catalog"); store.catalog(data)
        val stories = data.getJSONArray("stories"); val jobs = data.getJSONArray("jobs")
        mutable.value = mutable.value.copy(catalogReportedAt = System.currentTimeMillis(), catalog = (0 until stories.length()).map { stories.getJSONObject(it) }, jobs = (0 until jobs.length()).map { jobs.getJSONObject(it) })
    }
    fun follow(url: String, enabled: Boolean, mode: String) { viewModelScope.launch {
        val story = mutable.value.catalog.find { it.optString("url") == url }?.optString("id") ?: return@launch
        mutable.value = mutable.value.copy(updatingStories = mutable.value.updatingStories + story, storyErrors = mutable.value.storyErrors - story)
        try { api.call("/follow", JSONObject().put("url", url).put("enabled", enabled).put("mode", mode).put("buffer", 5).put("intervalHours", 6)); loadCatalog() }
        catch (e: Exception) { mutable.value = mutable.value.copy(storyErrors = mutable.value.storyErrors + (story to (e.message ?: "Couldn’t save settings. Try again."))) }
        finally { mutable.value = mutable.value.copy(updatingStories = mutable.value.updatingStories - story) }
    } }
    fun check(story: String) { viewModelScope.launch { try { api.call("/check", JSONObject().put("story", story)); loadCatalog() } catch (e: Exception) { message(e.message ?: "Could not check this story.") } } }
    fun job(id: String, action: String) {
        val story = mutable.value.jobs.find { it.optString("id") == id }?.optString("story")
            ?: mutable.value.catalog.find { it.optJSONObject("job")?.optString("id") == id }?.optString("id") ?: return
        if (story in mutable.value.updatingStories || mutable.value.offline || !mutable.value.canManage || !mutable.value.canGenerate) return
        mutable.value = mutable.value.copy(updatingStories = mutable.value.updatingStories + story, storyErrors = mutable.value.storyErrors - story)
        viewModelScope.launch {
            try { api.call("/jobs", JSONObject().put("id", id).put("action", action)); loadCatalog() }
            catch (e: Exception) { mutable.value = mutable.value.copy(storyErrors = mutable.value.storyErrors + (story to (e.message ?: "Couldn’t update preparation. Try again."))) }
            finally { mutable.value = mutable.value.copy(updatingStories = mutable.value.updatingStories - story) }
        }
    }
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
        store.library(data); load(data); loadCatalog(); mutable.value = mutable.value.copy(offline = false)
        if (changed) OfflineAudio.schedule(getApplication())
    }
    suspend fun poll() { runCatching { pollLibrary() } }
    fun disconnect() { viewModelScope.launch {
        if (mutable.value.loading) return@launch
        if (store.hasDrafts()) { message("Finish or discard your marked-issue drafts before signing out."); return@launch }
        controller?.run { pause() }
        mutable.value = mutable.value.copy(loading = true)
        try {
            api.sync()
            check(!store.hasPending()) { "Your saved work still needs to sync. Try again." }
            api.call("/devices/revoke", JSONObject())
            controller?.run { stop(); clearMediaItems() }
            credentials.clear(); androidx.work.WorkManager.getInstance(getApplication()).cancelAllWorkByTag("listener-download")
            OfflineAudio(getApplication()).let { audio ->
                audio.clear()
                val edit = audio.prefs.edit().remove("requested")
                audio.prefs.all.keys.filter { it.startsWith("paused:") || it.startsWith("selection:") }.forEach { edit.remove(it) }
                edit.apply()
            }
            store.clear(); mutable.value = ListenerUiState(message = "Signed out on this phone.")
        } catch (e: Exception) { message(e.message ?: "Couldn’t sign out. Your saved work is kept. Try again.") }
        finally { mutable.value = mutable.value.copy(loading = false) }
    } }
    fun refresh() { viewModelScope.launch {
        mutable.value = mutable.value.copy(loading = true)
        try { api.sync(); val capabilities = api.call("/capabilities"); mutable.value = mutable.value.copy(accountLabel = capabilities.optString("accountLabel"), canManage = capabilities.getJSONObject("permissions").optBoolean("manageLibrary"), canGenerate = capabilities.getJSONObject("permissions").optBoolean("generate")); val data = api.call("/library"); store.library(data); OfflineAudio.schedule(getApplication()); load(data); loadCatalog(); mutable.value = mutable.value.copy(offline = false); message("Your progress is synced.") }
        catch (e: Exception) { mutable.value = mutable.value.copy(offline = !hasNetwork()); message("${e.message ?: "Offline."} Progress and issues stay saved on this phone.") }
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
    fun play(book: Book, edition: String, chapter: Chapter) = startPlayback(Selection(book.id, book.title, edition, chapter), null)
    fun playChapter(book: Book, edition: String, chapter: Chapter) {
        val selected = Selection(book.id, book.title, edition, chapter)
        startPlayback(selected, if (mutable.value.selection?.key == selected.key) mutable.value.position else 0.0)
    }
    private fun startPlayback(selected: Selection, seconds: Double?) {
        cancelReturn(); val generation = navigationGeneration
        viewModelScope.launch {
            try { api.checkAudio(selected); if (generation == navigationGeneration) prepare(selected, seconds, true, true) }
            catch (e: Exception) { message(e.message ?: "This recording is unavailable. Your current audio is kept.") }
        }
    }
    private fun prepare(selected: Selection, seconds: Double?, autoplay: Boolean, recordJump: Boolean = false) {
        val p = controller ?: return message("Player is starting. Try again shortly.")
        val previous = mutable.value.selection?.let { old -> describeLocalLocation(old, mutable.value.reading, undoPosition(old.chapter, mutable.value.reading, mutable.value.includeAuthorNotes, mutable.value.position)) }
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
        } else if (p.playWhenReady && p.playbackState != Player.STATE_ENDED) p.pause() else { if (p.playbackState == Player.STATE_ENDED) p.seekToDefaultPosition(); if (p.playbackState == Player.STATE_IDLE) p.prepare(); p.play() }
    }
    fun seek(seconds: Double) { move(seconds, "seek") }
    fun skip(seconds: Int) {
        val p = controller ?: return
        if (p.currentMediaItem == null) mutable.value.selection?.let { prepare(it, null, false) }
        if (seconds < 0) p.seekBack() else p.seekForward()
    }
    fun passage(seconds: Double) { move(seconds, "passage") }
    fun passageAt(selection: Selection, seconds: Double) {
        if (mutable.value.selection?.key == selection.key) { passage(seconds); return }
        val generation = ++navigationGeneration
        viewModelScope.launch {
            try { api.checkAudio(selection); if (generation == navigationGeneration) prepare(selection, seconds, controller?.playWhenReady == true, true) }
            catch (e: Exception) { message(e.message ?: "Audio is unavailable. Your place is kept.") }
        }
    }
    private fun move(seconds: Double, reason: String) {
        cancelReturn()
        val selected = mutable.value.selection ?: return
        val from = describeLocalLocation(selected, mutable.value.reading, undoPosition(selected.chapter, mutable.value.reading, mutable.value.includeAuthorNotes, mutable.value.position))
        val view = chapterView(selected.chapter, mutable.value.reading, mutable.value.includeAuthorNotes)
        val target = view.source(view.position(seconds))
        if (controller?.currentMediaItem == null) prepare(selected, target, false) else controller?.seekTo((view.position(target) * 1000).toLong())
        store.saveProgress(selected, target, reason = reason, from = from)
        mutable.value = mutable.value.copy(position = target, undo = from)
    }
    fun cancelReturn() { navigationGeneration++; mutable.value = mutable.value.copy(returning = false, returnError = "") }
    fun returnTo(location: JSONObject) {
        val generation = ++navigationGeneration
        val departure = mutable.value.selection?.let { describeLocalLocation(it, mutable.value.reading, mutable.value.position) }
        mutable.value = mutable.value.copy(returning = true, returnError = "")
        viewModelScope.launch {
            try {
                val book = mutable.value.books.find { it.id == location.getString("story") } ?: error("Story is unavailable.")
                val edition = location.getString("edition")
                val assembly = location.getString("assembly")
                val text = store.reading(assembly) ?: api.call("/stories/${book.id}/$edition/text/$assembly").also { store.reading(assembly, it) }
                val chapter = book.editions[edition]?.find { it.assembly == assembly }
                    ?: Chapter(text.getString("chapterId"), text.optInt("sequence", location.optInt("chapter", 0)), text.getString("title"), assembly, text.getDouble("duration"), text.optString("checksum"))
                val selected = Selection(book.id, book.title, edition, chapter)
                api.checkAudio(selected)
                if (generation != navigationGeneration) return@launch
                val target = undoPosition(chapter, readingFromJson(text), mutable.value.includeAuthorNotes, location.getDouble("seconds"))
                val wasPlaying = controller?.playWhenReady == true
                if (controller == null) select(selected) else prepare(selected, target, wasPlaying, false)
                if (departure != null) { store.saveProgress(selected, target, reason = "restore", from = departure); mutable.value = mutable.value.copy(undo = departure, returnVersion = mutable.value.returnVersion + 1) }
            } catch (e: Exception) { if (generation == navigationGeneration) { val error = e.message ?: "Couldn’t open this recording. Your current audio is still in place. Try again."; mutable.value = mutable.value.copy(returnError = error); message(error) } }
            finally { if (generation == navigationGeneration) mutable.value = mutable.value.copy(returning = false) }
        }
    }
    fun switchEdition(edition: String) {
        val old = mutable.value.selection ?: return
        if (edition == old.edition || mutable.value.switchingEdition) return
        val book = mutable.value.books.find { it.id == old.story } ?: return
        val chapter = book.editions[edition]?.find { it.id == old.chapter.id } ?: run { val error = "This chapter is unavailable in that edition. Your place is kept."; mutable.value = mutable.value.copy(editionError = error); message(error); return }
        val generation = ++navigationGeneration
        mutable.value = mutable.value.copy(switchingEdition = true, editionError = "")
        viewModelScope.launch {
            try {
                val source = store.reading(old.chapter.assembly)?.let(::readingFromJson) ?: mutable.value.reading ?: error("Wait for the current passage to load.")
                val text = store.reading(chapter.assembly) ?: api.call("/stories/${old.story}/$edition/text/${chapter.assembly}").also { store.reading(chapter.assembly, it) }
                val selected = Selection(old.story, old.bookTitle, edition, chapter)
                api.checkAudio(selected)
                if (generation != navigationGeneration || mutable.value.selection?.key != old.key) return@launch
                val seconds = editionPosition(source, readingFromJson(text), mutable.value.position) ?: error("This passage is unavailable in that edition. Your place is kept.")
                val wasPlaying = controller?.playWhenReady == true
                prepare(selected, seconds, wasPlaying, false)
                store.saveProgress(selected, seconds, reason = "playing")
                message("")
            } catch (e: Exception) { if (generation == navigationGeneration) { val error = e.message ?: "Couldn’t change edition. Your place is kept."; mutable.value = mutable.value.copy(editionError = error); message(error) } }
            finally { mutable.value = mutable.value.copy(switchingEdition = false) }
        }
    }
    fun history(earlier: Boolean = false) { viewModelScope.launch {
        val story = mutable.value.selection?.story ?: return@launch
        mutable.value = mutable.value.copy(returnError = "")
        try {
            api.sync()
            val before = mutable.value.historyBefore.takeIf { earlier && mutable.value.historyStory == story }
            val page = api.call("/history?story=$story&jumps=1" + (before?.let { "&before=$it" } ?: ""))
            val entries = jsonObjects(page.getJSONArray("entries"))
            val merged = (if (earlier) mutable.value.history else mutable.value.history.filter { it.optJSONObject("from")?.optString("story") != story }) + entries
            val unique = merged.distinctBy { it.optString("eventId") }
            store.cachedHistory(unique)
            mutable.value = mutable.value.copy(history = unique, historyStory = story, historyBefore = if (page.isNull("before")) null else page.getLong("before"))
        } catch (e: Exception) { mutable.value = mutable.value.copy(returnError = "Recent jumps could not sync. Saved locations are still here."); message("Recent jumps could not sync. Saved locations are still here.") }
    } }

    fun speed(value: Float) { if (!value.isFinite() || value !in .1f..4f) return; store.speed(value); controller?.setPlaybackSpeed(value); mutable.value = mutable.value.copy(speed = value) }
    fun includeAuthorNotes(value: Boolean) { store.includeAuthorNotes(value); mutable.value = mutable.value.copy(includeAuthorNotes = value) }
    fun markIssue(selection: Selection, seconds: Double, kind: String, note: String) {
        saveIssue(selection, seconds, kind, note)
    }
    fun saveIssue(selection: Selection, seconds: Double, kind: String, note: String): Boolean = try {
        store.issue(selection, seconds, kind, note); message("Issue saved at ${formatTime(seconds)}."); refresh(); true
    } catch (e: Exception) { message("Couldn’t save the issue. Your draft is kept."); false }
    fun finished() { mutable.value.selection?.let { store.saveProgress(it, mutable.value.position, true); refresh() } }
    fun resolve(issue: JSONObject) {
        val id = issue.getString("id")
        if (!mutable.value.canManage || mutable.value.offline || id in mutable.value.resolvingIssues) return
        val resolved = issue.getString("status") == "open"
        mutable.value = mutable.value.copy(resolvingIssues = mutable.value.resolvingIssues + id, issueErrors = mutable.value.issueErrors - id)
        viewModelScope.launch {
            try {
                api.call("/issues/resolve", JSONObject().put("id", id).put("resolved", resolved))
                val issues = mutable.value.issues.map { if (it.optString("id") == id) JSONObject(it.toString()).put("status", if (resolved) "resolved" else "open") else it }
                store.library()?.let { cached -> cached.optJSONObject("state")?.put("issues", org.json.JSONArray(issues)); store.library(cached) }
                mutable.value = mutable.value.copy(issues = issues)
                runCatching { api.call("/library") }.onSuccess { canonical ->
                    store.library(canonical)
                    mutable.value = mutable.value.copy(issues = jsonObjects(canonical.getJSONObject("state").optJSONArray("issues")))
                }.onFailure { message("Status saved. Reports couldn’t refresh. Sync to retry.") }
            } catch (e: Exception) { mutable.value = mutable.value.copy(issueErrors = mutable.value.issueErrors + (id to (e.message ?: "Couldn’t update the issue. Try again."))) }
            finally { mutable.value = mutable.value.copy(resolvingIssues = mutable.value.resolvingIssues - id) }
        }
    }
    fun characters(story: String) { viewModelScope.launch { try { val a = api.call("/stories/$story/characters").getJSONArray("characters"); mutable.value = mutable.value.copy(characters = (0 until a.length()).map { a.getJSONObject(it) }) } catch (e: Exception) { message(e.message ?: "Could not load characters.") } } }
    override fun onCleared() { network.unregisterNetworkCallback(networkCallback); MediaController.releaseFuture(future); super.onCleared() }
}
data class ListenerUiState(val connected: Boolean = false, val books: List<Book> = emptyList(), val selection: Selection? = null,
    val playing: Boolean = false, val position: Double = 0.0, val speed: Float = 1f, val loading: Boolean = false, val includeAuthorNotes: Boolean = true,
    val offline: Boolean = false, val catalogReportedAt: Long = 0, val returnVersion: Int = 0, val message: String = "", val pairCode: String = "", val signingIn: Boolean = false, val signInUrl: String = "", val issues: List<JSONObject> = emptyList(), val pending: Int = 0,
    val accountLabel: String = "", val historyStory: String = "", val canManage: Boolean = false, val canGenerate: Boolean = false, val returning: Boolean = false, val returnError: String = "", val switchingEdition: Boolean = false, val editionError: String = "", val localJumps: List<JSONObject> = emptyList(),
    val catalog: List<JSONObject> = emptyList(), val jobs: List<JSONObject> = emptyList(),
    val issueErrors: Map<String, String> = emptyMap(), val resolvingIssues: Set<String> = emptySet(), val updatingStories: Set<String> = emptySet(), val storyErrors: Map<String, String> = emptyMap(),
    val reading: Reading? = null, val history: List<JSONObject> = emptyList(), val historyBefore: Long? = null, val undo: JSONObject? = null,
    val positions: List<JSONObject> = emptyList(), val completed: Set<String> = emptySet(), val characters: List<JSONObject> = emptyList())
