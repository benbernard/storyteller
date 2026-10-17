package com.crabanddog.listener

import android.net.Uri

import android.app.PendingIntent
import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import org.json.JSONObject

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null
    private lateinit var store: ListenerStore
    private var active: Selection? = null
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
        val player = ExoPlayer.Builder(this).setMediaSourceFactory(DefaultMediaSourceFactory(ResolvingDataSource.Factory(source) { spec -> spec.withUri(OfflineAudio(this).resolve(spec.uri)) })).build().apply {
            setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).build(), true)
            setHandleAudioBecomingNoisy(true)
            setWakeMode(C.WAKE_MODE_LOCAL)
            setPlaybackSpeed(store.speed())
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        session = MediaSession.Builder(this, player).setSessionActivity(open).build()
        player.addListener(object : Player.Listener {
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                active = mediaItem?.mediaMetadata?.extras?.getString("selection")?.let { runCatching { selectionFromJson(JSONObject(it)) }.getOrNull() }
                active?.let { store.select(it) }
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) { if (!isPlaying) save() }
            override fun onPlaybackStateChanged(playbackState: Int) { if (playbackState == Player.STATE_ENDED) save(true) }
            override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
                val old = oldPosition.mediaItem?.mediaMetadata?.extras?.getString("selection")?.let { runCatching { selectionFromJson(JSONObject(it)) }.getOrNull() }
                val next = newPosition.mediaItem?.mediaMetadata?.extras?.getString("selection")?.let { runCatching { selectionFromJson(JSONObject(it)) }.getOrNull() }
                if (reason == Player.DISCONTINUITY_REASON_AUTO_TRANSITION && old != null) store.saveProgress(old, old.chapter.duration, true)
                if (next != null) store.saveProgress(next, newPosition.positionMs.coerceAtLeast(0) / 1000.0,
                    reason = if (old?.chapter?.assembly != next.chapter.assembly) "chapter" else "seek",
                    from = old?.location(oldPosition.positionMs.coerceAtLeast(0) / 1000.0))
            }
        })
        scope.launch {
            while (true) {
                delay(5000)
                if (player.isPlaying) save()
                runCatching { ListenerApi(this@PlaybackService).sync() }
            }
        }
    }
    private fun save(completed: Boolean = false) {
        val player = session?.player ?: return
        active?.let { store.saveProgress(it, player.currentPosition.coerceAtLeast(0) / 1000.0, completed, reason = if (player.isPlaying) "playing" else "pause") }
    }
    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? =
        if (controllerInfo.packageName == packageName || controllerInfo.isTrusted) session else null
    override fun onTaskRemoved(rootIntent: Intent?) { save(); if (session?.player?.isPlaying != true) stopSelf() }
    override fun onDestroy() { save(); scope.cancel(); session?.run { player.release(); release() }; session = null; super.onDestroy() }
}
