package com.crabanddog.listener

import androidx.media3.common.C
import androidx.media3.common.ForwardingSimpleBasePlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.Timeline
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.Futures

/** MediaSession and every controller see the same note-free playback clock. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class ChapterPlayer(player: Player, private val view: (MediaItem) -> ChapterView?) : ForwardingSimpleBasePlayer(player) {
    fun refresh() = invalidateState()
    private fun duration(index: Int): Double? = view(player.getMediaItemAt(index))?.duration
        ?: player.currentTimeline.getWindow(index, Timeline.Window()).durationMs.takeIf { it >= 0 }?.div(1000.0)
    private fun source(items: List<MediaItem>, index: Int, positionMs: Long): Long {
        if (positionMs == C.TIME_UNSET) return positionMs
        return items.getOrNull(index)?.let(view)?.source(positionMs / 1000.0)?.let { kotlin.math.round(it * 1000).toLong() } ?: positionMs
    }
    override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
        if (seekCommand == Player.COMMAND_SEEK_BACK || seekCommand == Player.COMMAND_SEEK_FORWARD) {
            var index = player.currentMediaItemIndex
            val current = view(player.currentMediaItem ?: return Futures.immediateVoidFuture())
            var position = (current?.position(player.currentPosition / 1000.0) ?: (player.currentPosition / 1000.0)) +
                (if (seekCommand == Player.COMMAND_SEEK_BACK) -seekBackIncrement else seekForwardIncrement) / 1000.0
            while (position < 0 && index > 0) {
                index--
                val duration = duration(index)
                if (duration == null) { position = 0.0; break }
                position += duration
            }
            while (index < player.mediaItemCount - 1) {
                val duration = duration(index) ?: break
                if (position <= duration) break
                position -= duration; index++
            }
            player.seekTo(index, source((0 until player.mediaItemCount).map(player::getMediaItemAt), index, kotlin.math.round(position.coerceAtLeast(0.0) * 1000).toLong()))
            return Futures.immediateVoidFuture()
        }
        // SimpleBasePlayer has already resolved relative/back/forward commands
        // against the presented clock. Do not repeat them in the source clock.
        if (mediaItemIndex != C.INDEX_UNSET) player.seekTo(mediaItemIndex, source((0 until player.mediaItemCount).map(player::getMediaItemAt), mediaItemIndex, positionMs))
        return Futures.immediateVoidFuture()
    }

    override fun handleSetMediaItems(mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long): ListenableFuture<*> =
        super.handleSetMediaItems(mediaItems, startIndex, source(mediaItems, startIndex, startPositionMs))

    override fun getState(): SimpleBasePlayer.State {
        val state = super.getState()
        val playlist = state.playlist.map { data ->
            val chapter = view(data.mediaItem)
            if (chapter == null || chapter.removed.isEmpty()) data
            else data.buildUpon().setDurationUs(kotlin.math.round(chapter.duration * 1_000_000).toLong())
                .setDefaultPositionUs(kotlin.math.round(chapter.position(data.defaultPositionUs / 1_000_000.0) * 1_000_000).toLong())
                .setPositionInFirstPeriodUs(0)
                .setPeriods(emptyList()).build()
        }
        val current = state.playlist.getOrNull(state.currentMediaItemIndex)?.mediaItem?.let(view)
        if (current == null && playlist == state.playlist) return state
        fun position(ms: Long) = current?.position(ms / 1000.0)?.let { kotlin.math.round(it * 1000).toLong() } ?: ms
        val builder = state.buildUpon().setPlaylist(playlist)
            .setContentPositionMs(SimpleBasePlayer.PositionSupplier { position(player.currentPosition) })
            .setContentBufferedPositionMs(SimpleBasePlayer.PositionSupplier { position(player.bufferedPosition) })
            .setTotalBufferedDurationMs(SimpleBasePlayer.PositionSupplier { (position(player.bufferedPosition) - position(player.currentPosition)).coerceAtLeast(0) })
        if (state.hasPositionDiscontinuity) builder.setPositionDiscontinuity(state.positionDiscontinuityReason, position(state.discontinuityPositionMs))
        return builder.build()
    }
}
