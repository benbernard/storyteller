package com.crabanddog.listener

import android.net.Uri

import android.app.PendingIntent
import android.content.Intent
import android.content.SharedPreferences
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.Job
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import okhttp3.OkHttpClient
import org.json.JSONObject

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null
    private lateinit var store: ListenerStore
    private var active: Selection? = null
    private lateinit var audioPlayer: ExoPlayer
    private lateinit var noteAudio: AuthorNoteAudioPolicy
    private lateinit var outputs: AudioOutputs
    private var chapterPlayer: ChapterPlayer? = null
    private var reading: Reading? = null
    private var readingJob: Job? = null
    private val sectionRequests = mutableMapOf<String, Deferred<Reading?>>()
    private val sectionViews = mutableMapOf<String, ChapterView>()
    private var readingLoading = false
    private var readingGeneration = 0
    private var resumeAfterReading = false
    private var applyingSkip = false
    private var internalSkip: Pair<String, Long>? = null
    private var completedNoteAssembly: String? = null
    private val settingsListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == "include-author-notes") {
            val shouldResume = audioPlayer.playWhenReady || resumeAfterReading
            noteAudio.includeNotes = store.includeAuthorNotes()
            // A same-position seek may be optimized away; stop flushes queued audio.
            audioPlayer.pause()
            audioPlayer.stop()
            audioPlayer.prepare()
            resumeAfterReading = shouldResume
            if (store.includeAuthorNotes()) releaseReadingGate() else {
                if (readingLoading) gateForReading()
                skipAuthorNotes()
                releaseReadingGate()
            }
            chapterPlayer?.refresh()
        }
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    override fun onCreate() {
        super.onCreate()
        store = ListenerStore.get(this)
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            check(request.url.host == Uri.parse(BuildConfig.LISTENER_URL).host && request.url.encodedPath.startsWith("/api/listener/stories/")) { "Unsupported audio location" }
            chain.proceed(request.newBuilder().header("Authorization", "Bearer ${Credentials(this).read().orEmpty()}").build())
        }.followRedirects(false).followSslRedirects(false).build()
        val source = DefaultDataSource.Factory(this, OkHttpDataSource.Factory(client))
        noteAudio = AuthorNoteAudioPolicy(store.includeAuthorNotes())
        outputs = AudioOutputs.get(this)
        val renderer = object : DefaultRenderersFactory(this) {
            override fun buildAudioSink(context: android.content.Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink =
                AuthorNoteAudioSink(DefaultAudioSink.Builder(context)
                    .setEnableFloatOutput(enableFloatOutput)
                    .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
                    .setAudioTrackProvider(outputs.trackProvider()).build(), noteAudio)
        }
        val sources = NoteMediaSourceFactory(ResolvingDataSource.Factory(source) { spec -> spec.withUri(OfflineAudio(this).resolve(spec.uri)) }, noteAudio, onPending = { selected -> scope.launch { sectionReading(selected) } }) { selected ->
            store.reading(selected.chapter.assembly)?.let { runCatching { readingFromJson(it) }.getOrNull() }?.takeIf { it.assembly == selected.chapter.assembly }
        }
        val player = ExoPlayer.Builder(this, renderer).setMediaSourceFactory(sources).setSeekBackIncrementMs(15000).setSeekForwardIncrementMs(30000).build().apply {
            setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).build(), true)
            setHandleAudioBecomingNoisy(true)
            setWakeMode(C.WAKE_MODE_LOCAL)
            setPlaybackSpeed(store.speed())
        }
        audioPlayer = player
        outputs.start(player)
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        // Keep play/pause intent separate from a temporary metadata-loading pause.
        // All controllers, including the lock screen, use this same gate.
        val controlled = object : ForwardingPlayer(player) {
            override fun play() { if (requestPlay()) player.play() }
            override fun setPlayWhenReady(playWhenReady: Boolean) { if (playWhenReady) play() else pause() }
            override fun pause() { resumeAfterReading = false; player.pause() }
            override fun seekTo(positionMs: Long) { beforeSeek(player.currentMediaItemIndex); player.seekTo(positionMs); skipAuthorNotes() }
            override fun seekTo(mediaItemIndex: Int, positionMs: Long) { beforeSeek(mediaItemIndex); player.seekTo(mediaItemIndex, positionMs); skipAuthorNotes() }
            override fun seekToDefaultPosition() { seekTo(player.currentMediaItemIndex, 0) }
            override fun seekToDefaultPosition(mediaItemIndex: Int) { seekTo(mediaItemIndex, 0) }
            override fun seekBack() { seekTo((player.currentPosition - player.seekBackIncrement).coerceAtLeast(0)) }
            override fun seekForward() { seekTo(player.currentPosition + player.seekForwardIncrement) }
            override fun seekToNextMediaItem() { if (player.hasNextMediaItem()) seekToDefaultPosition(player.nextMediaItemIndex) }
            override fun seekToPreviousMediaItem() { if (player.hasPreviousMediaItem()) seekToDefaultPosition(player.previousMediaItemIndex) }
            override fun seekToNext() { seekToNextMediaItem() }
            override fun seekToPrevious() { if (player.currentPosition > player.maxSeekToPreviousPosition || !player.hasPreviousMediaItem()) seekTo(0) else seekToPreviousMediaItem() }
        }
        chapterPlayer = ChapterPlayer(controlled) { item ->
            item.mediaMetadata.extras?.getString("selection")?.let { raw -> runCatching { selectionFromJson(JSONObject(raw)) }.getOrNull() }?.let { s ->
                if (store.includeAuthorNotes()) ChapterView(s.chapter.duration) else sectionViews.getOrPut(s.chapter.assembly) {
                    val cached = store.reading(s.chapter.assembly)?.let { runCatching { readingFromJson(it) }.getOrNull() }
                    chapterView(s.chapter, cached, false)
                }
            }
        }
        session = MediaSession.Builder(this, chapterPlayer!!).setSessionActivity(open).build()
        store.observeSettings(settingsListener)
        player.addListener(object : Player.Listener {
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                active = mediaItem?.mediaMetadata?.extras?.getString("selection")?.let { runCatching { selectionFromJson(JSONObject(it)) }.getOrNull() }
                active?.let { store.select(it) }
                loadReading()
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) { if (!isPlaying) save() }
            override fun onPlaybackStateChanged(playbackState: Int) { if (playbackState == Player.STATE_ENDED) save(true) }
            override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
                val old = oldPosition.mediaItem?.mediaMetadata?.extras?.getString("selection")?.let { runCatching { selectionFromJson(JSONObject(it)) }.getOrNull() }
                val next = newPosition.mediaItem?.mediaMetadata?.extras?.getString("selection")?.let { runCatching { selectionFromJson(JSONObject(it)) }.getOrNull() }
                val matchingSkip = internalSkip?.let { it.first == next?.chapter?.assembly && kotlin.math.abs(it.second - newPosition.positionMs) <= 2 } == true
                val automatic = applyingSkip || matchingSkip || reason != Player.DISCONTINUITY_REASON_SEEK
                if (matchingSkip) internalSkip = null
                if (reason == Player.DISCONTINUITY_REASON_AUTO_TRANSITION && old != null) store.saveProgress(old, old.chapter.duration, true)
                if (next != null) store.saveProgress(next, newPosition.positionMs.coerceAtLeast(0) / 1000.0,
                    reason = if (automatic) "playing" else if (old?.chapter?.assembly != next.chapter.assembly) "chapter" else "seek",
                    from = if (automatic) null else old?.let { s ->
                        val previous = store.reading(s.chapter.assembly)?.let { runCatching { readingFromJson(it) }.getOrNull() }
                        s.location(undoPosition(s.chapter, previous, store.includeAuthorNotes(), oldPosition.positionMs.coerceAtLeast(0) / 1000.0))
                    })
                skipAuthorNotes()
            }
        })
        scope.launch { while (true) { delay(50); if (player.isPlaying) skipAuthorNotes() } }
        scope.launch {
            while (true) {
                delay(5000)
                if (player.isPlaying) save()
                runCatching { ListenerApi(this@PlaybackService).sync() }
            }
        }
    }
    private fun beforeSeek(index: Int) {
        internalSkip = null
        completedNoteAssembly = null
        if (!store.includeAuthorNotes() && (index != audioPlayer.currentMediaItemIndex || readingLoading)) gateForReading()
    }
    private fun gateForReading() {
        resumeAfterReading = resumeAfterReading || audioPlayer.playWhenReady
        audioPlayer.pause()
    }
    private fun requestPlay(): Boolean {
        resumeAfterReading = true
        if (!store.includeAuthorNotes() && readingLoading) { gateForReading(); return false }
        skipAuthorNotes()
        if (!store.includeAuthorNotes() && readingLoading) return false
        // A final note can complete the last chapter without starting it again.
        val selected = active
        if (!store.includeAuthorNotes() && selected != null && completedNoteAssembly == selected.chapter.assembly) {
            resumeAfterReading = false
            return false
        }
        resumeAfterReading = false
        return true
    }
    private fun releaseReadingGate() {
        skipAuthorNotes()
        if (resumeAfterReading && (store.includeAuthorNotes() || !readingLoading)) session?.player?.play()
    }
    private fun loadReading() {
        completedNoteAssembly = null
        val generation = ++readingGeneration
        readingJob?.cancel()
        reading = null
        readingLoading = false
        val selected = active ?: return
        val cached = store.reading(selected.chapter.assembly)?.let { runCatching { readingFromJson(it) }.getOrNull() }
            ?.takeIf { it.assembly == selected.chapter.assembly }
        reading = cached
        sectionViews[selected.chapter.assembly] = chapterView(selected.chapter, cached, false)
        readingLoading = needsSectionRefresh(cached)
        noteAudio.update(selected, cached, readingLoading)
        if (!store.includeAuthorNotes() && readingLoading) gateForReading()
        skipAuthorNotes()
        // An all-note chapter can advance and reenter this method immediately.
        // Keep the next chapter's request handle and metadata generation intact.
        if (generation != readingGeneration || active?.chapter?.assembly != selected.chapter.assembly) return
        // Refresh old cached readings to obtain newly available positive tags.
        // Disabled notes wait for one refresh of an unversioned cache. A failed
        // refresh releases the gate and retains its unknown legacy content.
        readingJob = scope.launch {
            val loaded = sectionReading(selected)
            if (generation != readingGeneration || active?.chapter?.assembly != selected.chapter.assembly) return@launch
            if (loaded != null) reading = loaded
            readingLoading = false
            noteAudio.update(selected, reading, false)
            chapterPlayer?.refresh()
            releaseReadingGate()
        }
    }
    private suspend fun sectionReading(selected: Selection): Reading? {
        val key = selected.chapter.assembly
        val request = sectionRequests.getOrPut(key) {
            scope.async {
                runCatching {
                    val data = ListenerApi(this@PlaybackService).call("/stories/${selected.story}/${selected.edition}/text/$key")
                    val parsed = readingFromJson(data)
                    check(parsed.assembly == key)
                    store.reading(key, data)
                    parsed
                }.getOrNull()
            }
        }
        val loaded = request.await()
        if (sectionRequests[key] === request) sectionRequests.remove(key)
        val cached = loaded ?: store.reading(key)?.let { runCatching { readingFromJson(it) }.getOrNull() }?.takeIf { it.assembly == key }
        sectionViews[key] = chapterView(selected.chapter, cached, false)
        noteAudio.update(selected, cached, false)
        chapterPlayer?.refresh()
        return loaded
    }
    private fun skipAuthorNotes() {
        if (applyingSkip || store.includeAuthorNotes() || readingLoading) return
        val selected = active ?: return
        // Decoders can clamp an end seek to the final sample (duration - 1ms).
        // Do not repeatedly seek and emit completion events at that sample.
        if (completedNoteAssembly == selected.chapter.assembly) {
            if (audioPlayer.currentPosition + 50 >= (selected.chapter.duration * 1000).toLong()) return
            completedNoteAssembly = null
        }
        val playingSelection = audioPlayer.currentMediaItem?.mediaMetadata?.extras?.getString("selection")
            ?.let { runCatching { selectionFromJson(JSONObject(it)) }.getOrNull() }
        if (playingSelection != selected) return
        val position = audioPlayer.currentPosition.coerceAtLeast(0) / 1000.0
        val endingNote = sectionViews[selected.chapter.assembly]?.removed?.lastOrNull()?.takeIf { it.end >= selected.chapter.duration }
        val target = authorNoteEnd(reading, position, selected.chapter.duration)
            ?: selected.chapter.duration.takeIf { endingNote != null && position >= endingNote.start }
            ?: return
        applyingSkip = true
        try {
            if (target >= selected.chapter.duration) {
                store.saveProgress(selected, selected.chapter.duration, true)
                if (audioPlayer.hasNextMediaItem()) {
                    val next = audioPlayer.getMediaItemAt(audioPlayer.nextMediaItemIndex).mediaMetadata.extras?.getString("selection")?.let { runCatching { selectionFromJson(JSONObject(it)) }.getOrNull() }
                    internalSkip = next?.chapter?.assembly?.let { it to 0L }
                    audioPlayer.seekToNextMediaItem()
                } else { completedNoteAssembly = selected.chapter.assembly; internalSkip = selected.chapter.assembly to (selected.chapter.duration * 1000).toLong(); audioPlayer.seekTo((selected.chapter.duration * 1000).toLong()); resumeAfterReading = false; audioPlayer.pause() }
            } else {
                val positionMs = kotlin.math.ceil(target * 1000).toLong()
                internalSkip = selected.chapter.assembly to positionMs
                audioPlayer.seekTo(positionMs)
            }
        } finally { applyingSkip = false }
    }
    private fun save(completed: Boolean = false) {
        val player = audioPlayer
        active?.let { store.saveProgress(it, player.currentPosition.coerceAtLeast(0) / 1000.0, completed, reason = if (player.isPlaying) "playing" else "pause") }
    }
    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? =
        if (controllerInfo.packageName == packageName || controllerInfo.isTrusted) session else null
    override fun onTaskRemoved(rootIntent: Intent?) { save(); if (session?.player?.isPlaying != true) stopSelf() }
    override fun onDestroy() { save(); store.stopObservingSettings(settingsListener); scope.cancel(); outputs.stop(); session?.run { player.release(); release() }; session = null; super.onDestroy() }
}
