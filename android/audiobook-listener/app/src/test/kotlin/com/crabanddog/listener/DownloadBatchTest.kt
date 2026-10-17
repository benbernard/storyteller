package com.crabanddog.listener

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class DownloadBatchTest {
    private val chapters = (1..4).map { i -> Selection("book", "Book", "qwen", Chapter("$i", i, "Chapter $i", "$i".repeat(64), 60.0)) }

    @Test fun failedFirstAudioAndMiddleTextDoNotBlockOtherChapters() = runBlocking {
        val audio = mutableListOf<String>()
        val text = mutableListOf<String>()
        val result = downloadBatch(chapters,
            downloadAudio = { audio.add(it.chapter.id); if (it == chapters[0]) throw IOException("HTTP 500"); true },
            downloadText = { text.add(it.chapter.id); if (it == chapters[1]) throw IOException("Text unavailable") },
            beforeChapter = {},
        )
        assertEquals(listOf("1", "2", "3", "4"), audio)
        assertEquals(listOf("2", "3", "4"), text)
        assertEquals(3, result.ready)
        assertEquals(4, result.total)
        assertEquals(listOf(DownloadPart.AUDIO, DownloadPart.TEXT), result.failures.map { it.part })
        assertEquals(DownloadStop.FINISHED, result.stop)
    }

    @Test fun textFailureKeepsAudioAndRetryDoesNotTransferItAgain() = runBlocking {
        val cached = mutableSetOf<String>()
        var transfers = 0
        var broken = true
        val audio: suspend (Selection) -> Boolean = { if (cached.add(it.key)) transfers++; true }
        val text: suspend (Selection) -> Unit = { if (broken && it == chapters[0]) throw IOException("Permission denied") }
        val first = downloadBatch(chapters, audio, text, {})
        assertEquals(4, first.ready)
        assertEquals(DownloadPart.TEXT, first.failures.single().part)
        broken = false
        val retry = downloadBatch(chapters, audio, text, {})
        assertEquals(4, retry.ready)
        assertTrue(retry.failures.isEmpty())
        assertEquals(4, transfers)
    }

    @Test fun pausingOneSelectionDoesNotStopOtherBooks() = runBlocking {
        val visited = mutableListOf<String>()
        val result = downloadBatch(chapters, { visited.add(it.chapter.id); true }, {}, {}, shouldSkip = { it == chapters[0] })
        assertEquals(listOf("2", "3", "4"), visited)
        assertEquals(3, result.ready)
        assertTrue(result.failures.isEmpty())
    }

    @Test fun cancellationIsNeverRecordedAsAChapterFailure() = runBlocking {
        val visited = mutableListOf<String>()
        try {
            downloadBatch(chapters, { visited.add(it.key); throw CancellationException("Paused") }, {}, {})
            fail("Cancellation must stop the batch")
        } catch (expected: CancellationException) { assertEquals("Paused", expected.message) }
        assertEquals(1, visited.size)
    }

    @Test fun storageAndWorkBudgetStopWithoutAttemptingRemainingChapters() = runBlocking {
        val attempted = mutableListOf<String>()
        val storage = downloadBatch(chapters, { attempted.add(it.key); false }, {}, {})
        assertEquals(DownloadStop.STORAGE, storage.stop)
        assertEquals(1, attempted.size)
        val yielded = downloadBatch(chapters, { fail("No transfer after budget expiry"); true }, {}, {}, shouldYield = { true })
        assertEquals(DownloadStop.YIELD, yielded.stop)
        assertTrue(yielded.failures.isEmpty())
    }
}
