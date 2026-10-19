package com.crabanddog.listener

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.exoplayer.audio.AudioSink
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.lang.reflect.Proxy
import java.nio.ByteBuffer
import java.nio.ByteOrder

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class AuthorNoteAudioTest {
    private val selection = Selection("story", "Story", "test", Chapter("one", 1, "Chapter", "a".repeat(64), 8.0, "hash"))
    private fun reading(assembly: String = selection.chapter.assembly, start: Double = 1.0, end: Double = 2.0) = Reading(assembly, listOf(Passage("note", start, end, "note", "author-note")), 1)
    private fun format(assembly: String = selection.chapter.assembly) = Format.Builder().setSampleMimeType(MimeTypes.AUDIO_RAW).setSampleRate(1000).setChannelCount(2).setPcmEncoding(C.ENCODING_PCM_16BIT).setCustomData(NoteAudioKey(assembly)).build()
    private class Capture(private val limit: Int = Int.MAX_VALUE) {
        val bytes = ByteArrayOutputStream()
        val sink = Proxy.newProxyInstance(AudioSink::class.java.classLoader, arrayOf(AudioSink::class.java)) { _, method, args ->
            when (method.name) {
                "handleBuffer" -> { val b = args!![0] as ByteBuffer; val n = minOf(b.remaining(), limit); repeat(n) { bytes.write(b.get().toInt()) }; !b.hasRemaining() }
                "supportsFormat" -> true
                "getFormatSupport" -> AudioSink.SINK_FORMAT_SUPPORTED_DIRECTLY
                else -> when (method.returnType) { Boolean::class.javaPrimitiveType -> false; Int::class.javaPrimitiveType -> 0; Long::class.javaPrimitiveType -> 0L; Float::class.javaPrimitiveType -> 1f; else -> null }
            }
        } as AudioSink
    }
    @Test fun queuedNoteSamplesAreSilentEvenWhenTheApplicationDoesNotSeek() {
        val policy = AuthorNoteAudioPolicy(false); policy.update(selection, reading(), false)
        val capture = Capture(128); val sink = AuthorNoteAudioSink(capture.sink, policy); sink.configure(format(), 0, null)
        sink.setOutputStreamOffsetUs(9_000_000)
        val original = ByteArray(3 * 1000 * 4) { 0x36 }; val buffer = ByteBuffer.wrap(original).asReadOnlyBuffer().order(ByteOrder.LITTLE_ENDIAN)
        while (!sink.handleBuffer(buffer, 9_000_000, 1)) { /* Deliberately no playback callback or skip. */ }
        val expected = original.copyOf(); expected.fill(0, 4000, 8000)
        assertArrayEquals(expected, capture.bytes.toByteArray()); assertTrue(original.all { it == 0x36.toByte() })
        assertEquals(buffer.limit(), buffer.position())
    }
    @Test fun metadataWaitRetainsAnnouncementAndBodySamplesAndUsesDecodedChapterIdentity() {
        val policy = AuthorNoteAudioPolicy(false); policy.register(selection, null)
        val capture = Capture(); val sink = AuthorNoteAudioSink(capture.sink, policy); sink.configure(format(), 0, null)
        val buffer = ByteBuffer.wrap(ByteArray(4000) { 7 }).order(ByteOrder.LITTLE_ENDIAN)
        assertFalse(sink.handleBuffer(buffer, 0, 1)); assertEquals(0, buffer.position()); assertEquals(0, capture.bytes.size())
        policy.update(selection, reading(), false); assertTrue(sink.handleBuffer(buffer, 0, 1)); assertTrue(capture.bytes.toByteArray().all { it == 7.toByte() })
        val second = selection.copy(chapter = selection.chapter.copy(assembly = "b".repeat(64)))
        policy.update(second, reading(second.chapter.assembly, 0.0, 1.0), false)
        sink.configure(format(second.chapter.assembly), 0, null); sink.setOutputStreamOffsetUs(20_000_000)
        assertTrue(sink.handleBuffer(ByteBuffer.wrap(ByteArray(4000) { 8 }).order(ByteOrder.LITTLE_ENDIAN), 20_000_000, 1))
        assertTrue(capture.bytes.toByteArray().takeLast(4000).all { it == 0.toByte() })
    }
    @Test fun includedNotesAndUnknownSectionsKeepOriginalSamplesAndPassthroughIsDisabled() {
        val policy = AuthorNoteAudioPolicy(true); val capture = Capture(); val sink = AuthorNoteAudioSink(capture.sink, policy); sink.configure(format(), 0, null)
        val pcm = ByteArray(4000) { 12 }; sink.handleBuffer(ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN), 0, 1)
        assertArrayEquals(pcm, capture.bytes.toByteArray())
        assertFalse(sink.supportsFormat(Format.Builder().setSampleMimeType(MimeTypes.AUDIO_MPEG).build()))
        assertFalse(sink.getFormatOffloadSupport(format()).isFormatSupported)
        policy.includeNotes = false; policy.update(selection, Reading(selection.chapter.assembly, listOf(Passage("legacy", 0.0, 2.0, "unknown")), 1), false)
        sink.flush();sink.handleBuffer(ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN), 0, 1)
        assertArrayEquals(pcm + pcm, capture.bytes.toByteArray())
    }
    @Test fun sampleClockAccountsForEncoderTrimAndResetsAfterSeekWithoutTrimmingAgain() {
        val clock = NoteSampleClock(); clock.configure(100)
        assertEquals(-100_000, clock.bufferStartUs(0, 500, 1000))
        assertEquals(400_000, clock.bufferStartUs(500_000, 500, 1000))
        clock.flush(); assertEquals(3_000_000, clock.bufferStartUs(3_000_000, 500, 1000))
        assertEquals(3_500_000, clock.bufferStartUs(3_500_000, 500, 1000))
    }
}
