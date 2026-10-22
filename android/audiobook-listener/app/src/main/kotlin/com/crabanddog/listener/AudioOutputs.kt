package com.crabanddog.listener

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioRouting
import android.media.AudioTrack
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.DefaultAudioSink
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

internal data class AudioOutput(val id: Int, val name: String, val bluetooth: Boolean)
internal data class AudioOutputState(
    val devices: List<AudioOutput> = emptyList(),
    val routed: Int? = null,
    val requested: Int? = null,
    val playing: Boolean = false,
    val volume: Float = 1f,
    val available: Boolean = false,
    val error: String = "",
)

/** Owns only Listener's output preference. A request is never proof of a route change. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
internal class AudioOutputs private constructor(context: Context) {
    private val audio = context.getSystemService(AudioManager::class.java)
    private val handler = Handler(Looper.getMainLooper())
    private val mutable = MutableStateFlow(AudioOutputState())
    val state = mutable.asStateFlow()
    private var player: ExoPlayer? = null
    private var track: AudioTrack? = null
    private var generation = 0
    private var requestedAt = 0L
    private var preferred: Int? = null
    private val routing = AudioRouting.OnRoutingChangedListener { refresh() }
    private val devices = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = refresh()
        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) {
            if (removed.any { it.id == preferred }) {
                player?.setPreferredAudioDevice(null)
                preferred = null
                mutable.value = mutable.value.copy(requested = null, error = "The selected device disconnected.")
            }
            refresh()
        }
    }

    // Called on the playback thread; observe the actual AudioTrack on the main thread.
    fun trackProvider(): DefaultAudioSink.AudioTrackProvider {
        val owner = generation
        return DefaultAudioSink.AudioTrackProvider { config, attributes, session, context ->
            DefaultAudioSink.AudioTrackProvider.DEFAULT.getAudioTrack(config, attributes, session, context).also { created ->
                handler.post {
                    if (owner == generation && player != null) {
                        track?.removeOnRoutingChangedListener(routing)
                        track = created
                        created.addOnRoutingChangedListener(routing, handler)
                        refresh()
                    }
                }
            }
        }
    }

    fun start(player: ExoPlayer) {
        check(this.player == null)
        this.player = player
        audio.registerAudioDeviceCallback(devices, handler)
        refresh()
    }

    fun stop() {
        generation++
        audio.unregisterAudioDeviceCallback(devices)
        track?.removeOnRoutingChangedListener(routing)
        track = null
        player = null
        preferred = null
        mutable.value = AudioOutputState()
    }

    fun select(id: Int) {
        val device = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull { it.id == id && mediaOutput(it) }
        val current = player
        if (device == null || current == null) {
            mutable.value = mutable.value.copy(error = "This device is no longer available.")
            refresh()
            return
        }
        requestedAt = SystemClock.elapsedRealtime()
        preferred = id
        mutable.value = mutable.value.copy(requested = id, error = "")
        runCatching { current.setPreferredAudioDevice(device) }.onFailure {
            preferred = null
            mutable.value = mutable.value.copy(requested = null, error = "Couldn’t change the audio output. Try again.")
        }
        refresh()
    }

    fun volume(value: Float) {
        player?.volume = value.coerceIn(0f, 1f)
        refresh()
    }

    fun refresh() {
        val current = player ?: return
        val outputs = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).filter(::mediaOutput)
        val routed = track?.takeIf { it.state == AudioTrack.STATE_INITIALIZED }?.routedDevice?.id
        val previous = mutable.value
        if (current.isPlaying && !previous.playing && previous.requested != null) requestedAt = SystemClock.elapsedRealtime()
        val timedOut = previous.requested != null && routed != previous.requested && current.isPlaying && SystemClock.elapsedRealtime() - requestedAt >= 8000
        mutable.value = previous.copy(
            devices = outputs.sortedWith(compareBy<AudioDeviceInfo> { it.type != AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }.thenBy { it.productName.toString() }.thenBy { it.id }).map {
                AudioOutput(it.id, if (it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) "This phone" else it.productName.toString(), bluetooth(it))
            },
            routed = routed,
            requested = previous.requested?.takeUnless { it == routed },
            playing = current.isPlaying,
            volume = current.volume,
            available = true,
            error = if (previous.requested != null && routed == previous.requested) "" else if (timedOut) "The output hasn’t changed. Try the device again or open device settings." else previous.error,
        )
    }

    companion object {
        @Volatile private var instance: AudioOutputs? = null
        fun get(context: Context): AudioOutputs = instance ?: synchronized(this) {
            instance ?: AudioOutputs(context.applicationContext).also { instance = it }
        }
        private fun bluetooth(device: AudioDeviceInfo): Boolean = device.type in setOf(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER, AudioDeviceInfo.TYPE_HEARING_AID)
        private fun mediaOutput(device: AudioDeviceInfo): Boolean = device.isSink && device.type !in setOf(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE, AudioDeviceInfo.TYPE_TELEPHONY, AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_REMOTE_SUBMIX)
    }
}
