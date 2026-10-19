package com.crabanddog.listener

import android.os.Looper
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.Timeline
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class ChapterPlayerTest {
    private class Recording : SimpleBasePlayer(Looper.getMainLooper()) {
        var sourcePosition = 50_000L
        var sourceIndex = 0
        private var snapshot = State.Builder().setAvailableCommands(Player.Commands.Builder().addAllCommands().build())
            .setPlaylist(listOf("one", "two").map { MediaItemData.Builder(it).setMediaItem(MediaItem.fromUri("https://example.org/$it"))
                .setDurationUs(120_000_000).setIsSeekable(true).build() })
            .setPlaybackState(Player.STATE_READY).setCurrentMediaItemIndex(0).setContentPositionMs(sourcePosition)
            .setContentBufferedPositionMs(PositionSupplier { 120_000 }).setSeekBackIncrementMs(15_000).setSeekForwardIncrementMs(30_000).build()
        override fun getState(): State = snapshot
        override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
            sourcePosition = positionMs
            sourceIndex = mediaItemIndex
            snapshot = snapshot.buildUpon().setCurrentMediaItemIndex(sourceIndex).setContentPositionMs(sourcePosition).build()
            return Futures.immediateVoidFuture()
        }
    }
    @Test fun fifteenSecondsBackCrossesIntoThePreviousChapterWithoutCountingNotes() {
        val recording = Recording()
        val player = ChapterPlayer(recording) { ChapterView(120.0, listOf(AudioRange(10.0, 30.0), AudioRange(90.0, 120.0))) }
        player.seekTo(1, 0)
        player.seekBack()
        assertEquals(0, recording.sourceIndex)
        assertEquals(75_000, recording.sourcePosition)
        assertEquals(55_000, player.currentPosition)
        player.seekTo(1, 5_000)
        player.seekBack()
        assertEquals(0, recording.sourceIndex)
        assertEquals(80_000, recording.sourcePosition)
        assertEquals(60_000, player.currentPosition)
        player.seekForward()
        assertEquals(1, recording.sourceIndex)
        assertEquals(40_000, recording.sourcePosition)
        assertEquals(20_000, player.currentPosition)
    }
    @Test fun appAndLockScreenUseOneFilteredClockForAbsoluteAndRelativeSeeks() {
        val recording = Recording()
        var include = false
        val player = ChapterPlayer(recording) { ChapterView(120.0, if (include) emptyList() else listOf(AudioRange(10.0, 30.0), AudioRange(90.0, 120.0))) }
        assertEquals(70_000, player.duration)
        assertEquals(30_000, player.currentPosition)
        assertEquals(70_000, player.bufferedPosition)
        assertEquals(70_000, player.currentTimeline.getWindow(0, Timeline.Window()).durationMs)
        player.seekBack()
        assertEquals(35_000, recording.sourcePosition)
        assertEquals(15_000, player.currentPosition)
        player.seekForward()
        assertEquals(65_000, recording.sourcePosition)
        assertEquals(45_000, player.currentPosition)
        player.seekTo(10_000)
        assertEquals(30_000, recording.sourcePosition)
        assertEquals(10_000, player.currentPosition)
        include = true; player.refresh()
        assertEquals(120_000, player.duration)
        assertEquals(30_000, player.currentPosition)
        include = false; player.refresh()
        assertEquals(10_000, player.currentPosition)
        player.seekBack()
        assertEquals(0, recording.sourcePosition)
        assertEquals(0, player.currentPosition)
        player.seekTo(70_000)
        assertEquals(120_000, recording.sourcePosition)
    }
}
