package com.crabanddog.listener

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.Util
import androidx.media3.datasource.DataSource
import androidx.media3.exoplayer.audio.AudioOffloadSupport
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.ForwardingAudioSink
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.ExtractorsFactory
import androidx.media3.extractor.ForwardingExtractor
import androidx.media3.extractor.TrackOutput
import org.json.JSONObject
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor

internal data class NoteAudioKey(val assembly: String)
internal data class NoteAudioRanges(val pending: Boolean, val ranges: List<Passage>)

/** Decoder-thread state, bound to the decoded chapter rather than a UI callback. */
internal class AuthorNoteAudioPolicy(include: Boolean) {
    @Volatile var includeNotes = include
    private val chapters = ConcurrentHashMap<String, NoteAudioRanges>()
    fun register(selection: Selection, cached: Reading?) {
        chapters.putIfAbsent(selection.chapter.assembly, NoteAudioRanges(needsSectionRefresh(cached), authorNoteRanges(cached, selection.chapter.duration)))
    }
    fun update(selection: Selection, reading: Reading?, pending: Boolean) {
        chapters[selection.chapter.assembly] = NoteAudioRanges(pending, authorNoteRanges(reading, selection.chapter.duration))
    }
    fun state(key: NoteAudioKey): NoteAudioRanges? = chapters[key.assembly]
}

/** Preserve the assembly identity through decoding, including prefetched chapters. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
internal class NoteMediaSourceFactory(
    private val source: DataSource.Factory,
    private val policy: AuthorNoteAudioPolicy,
    private val onPending: (Selection) -> Unit,
    private val reading: (Selection) -> Reading?,
) : MediaSource.Factory by DefaultMediaSourceFactory(source) {
    override fun createMediaSource(mediaItem: MediaItem): MediaSource {
        val selected = mediaItem.mediaMetadata.extras?.getString("selection")?.let {
            runCatching { selectionFromJson(JSONObject(it)) }.getOrNull()
        } ?: return DefaultMediaSourceFactory(source).createMediaSource(mediaItem)
        val cached = reading(selected)
        policy.register(selected, cached)
        if (needsSectionRefresh(cached)) onPending(selected)
        val key = NoteAudioKey(selected.chapter.assembly)
        val extractors = object : ExtractorsFactory {
            override fun createExtractors(): Array<Extractor> = DefaultExtractorsFactory().createExtractors().map { extractor ->
                object : ForwardingExtractor(extractor) {
                    override fun init(output: ExtractorOutput) {
                        super.init(object : ExtractorOutput by output {
                            override fun track(id: Int, type: Int): TrackOutput {
                                val track = output.track(id, type)
                                return object : TrackOutput by track {
                                    override fun format(format: Format) {
                                        track.format(format.buildUpon().setId("${key.assembly}:${format.id}").setCustomData(key).build())
                                    }
                                }
                            }
                        })
                    }
                }
            }.toTypedArray()
        }
        return ProgressiveMediaSource.Factory(source, extractors).createMediaSource(mediaItem)
    }
}

/** Silence excluded samples before AudioTrack buffering, preserving the source clock. */
internal fun silenceAuthorNoteSamples(buffer: ByteBuffer, startUs: Long, sampleRate: Int, bytesPerFrame: Int, silence: Byte, notes: List<Passage>) {
    require(sampleRate > 0 && bytesPerFrame > 0 && buffer.remaining() % bytesPerFrame == 0)
    val origin = buffer.position()
    val frames = buffer.remaining() / bytesPerFrame
    for (note in notes) {
        val first = floor((note.start * 1_000_000 - startUs) * sampleRate / 1_000_000).toLong().coerceIn(0, frames.toLong()).toInt()
        val last = ceil((note.end * 1_000_000 - startUs) * sampleRate / 1_000_000).toLong().coerceIn(0, frames.toLong()).toInt()
        for (index in origin + first * bytesPerFrame until origin + last * bytesPerFrame) buffer.put(index, silence)
    }
}

/** Mirror the sink's submitted-frame clock, including gapless encoder trimming. */
internal class NoteSampleClock {
    private var anchorUs: Double? = null
    private var submittedFrames = 0L
    private var trimmedFrames = 0L
    private var trimRemaining = 0
    fun configure(encoderDelay: Int) { trimRemaining = encoderDelay.coerceAtLeast(0); flush() }
    fun flush() { anchorUs = null; submittedFrames = 0; trimmedFrames = 0 }
    fun bufferStartUs(presentationUs: Long, frames: Int, sampleRate: Int): Long {
        var anchor = anchorUs ?: presentationUs.coerceAtLeast(0).toDouble()
        val expected = anchor + (submittedFrames - trimmedFrames) * 1_000_000.0 / sampleRate
        if (abs(expected - presentationUs) > 200_000) anchor += presentationUs - expected
        val trim = minOf(trimRemaining, frames)
        trimmedFrames += trim
        trimRemaining -= trim
        val start = anchor + (submittedFrames - trimmedFrames) * 1_000_000.0 / sampleRate
        submittedFrames += frames
        anchorUs = anchor
        return kotlin.math.round(start).toLong()
    }
}

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
internal class AuthorNoteAudioSink(sink: AudioSink, private val policy: AuthorNoteAudioPolicy) : ForwardingAudioSink(sink) {
    private var key: NoteAudioKey? = null
    private var sampleRate = 0
    private var bytesPerFrame = 0
    private var silence: Byte = 0
    private var streamOffsetUs = 0L
    private var original: ByteBuffer? = null
    private var filtered: ByteBuffer? = null
    private var originalStart = 0
    private val clock = NoteSampleClock()

    // Passthrough and offload would bypass the decoded-sample guard.
    override fun supportsFormat(format: Format): Boolean = format.sampleMimeType == MimeTypes.AUDIO_RAW && super.supportsFormat(format)
    override fun getFormatSupport(format: Format): Int = if (format.sampleMimeType == MimeTypes.AUDIO_RAW) super.getFormatSupport(format) else AudioSink.SINK_FORMAT_UNSUPPORTED
    override fun getFormatOffloadSupport(format: Format): AudioOffloadSupport = AudioOffloadSupport.DEFAULT_UNSUPPORTED
    override fun configure(inputFormat: Format, specifiedBufferSize: Int, outputChannels: IntArray?) {
        key = inputFormat.customData as? NoteAudioKey
        sampleRate = inputFormat.sampleRate
        bytesPerFrame = Util.getPcmFrameSize(inputFormat.pcmEncoding, inputFormat.channelCount)
        silence = if (inputFormat.pcmEncoding == C.ENCODING_PCM_8BIT) 0x80.toByte() else 0
        clearBuffer()
        clock.configure(inputFormat.encoderDelay)
        super.configure(inputFormat, specifiedBufferSize, outputChannels)
    }
    override fun setOutputStreamOffsetUs(outputStreamOffsetUs: Long) {
        streamOffsetUs = outputStreamOffsetUs
        super.setOutputStreamOffsetUs(outputStreamOffsetUs)
    }
    override fun handleBuffer(buffer: ByteBuffer, presentationTimeUs: Long, encodedAccessUnitCount: Int): Boolean {
        val chapter = key
        if (original !== buffer) {
            check(original == null) { "Audio buffer changed before consumption" }
            if (chapter == null) return super.handleBuffer(buffer, presentationTimeUs, encodedAccessUnitCount)
            val state = if (policy.includeNotes) NoteAudioRanges(false, emptyList()) else policy.state(chapter)
            // Hold the original samples until section metadata is available.
            if (state == null || state.pending) return false
            original = buffer
            originalStart = buffer.position()
            filtered = ByteBuffer.allocateDirect(buffer.remaining()).order(buffer.order()).apply {
                put(buffer.duplicate()); flip()
                val start = clock.bufferStartUs(presentationTimeUs - streamOffsetUs, remaining() / bytesPerFrame, sampleRate)
                silenceAuthorNoteSamples(this, start, sampleRate, bytesPerFrame, silence, state.ranges)
            }
        }
        val output = checkNotNull(filtered)
        val consumed = super.handleBuffer(output, presentationTimeUs, encodedAccessUnitCount)
        buffer.position(originalStart + output.position())
        if (consumed) clearBuffer()
        return consumed
    }
    private fun clearBuffer() { original = null; filtered = null }
    override fun flush() { clearBuffer(); clock.flush(); super.flush() }
    override fun reset() { clearBuffer(); clock.configure(0); key = null; super.reset() }
}
