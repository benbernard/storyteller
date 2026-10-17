package com.crabanddog.listener

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

enum class DownloadPart { AUDIO, TEXT }
data class ChapterDownloadFailure(val selection: Selection, val part: DownloadPart, val reason: String)
enum class DownloadStop { FINISHED, STORAGE, YIELD }
data class DownloadBatchResult(val ready: Int, val total: Int, val failures: List<ChapterDownloadFailure>, val stop: DownloadStop)

/** Audio is playable independently of reading text. Only cancellation/storage stop the queue. */
suspend fun downloadBatch(
    chapters: List<Selection>,
    downloadAudio: suspend (Selection) -> Boolean,
    downloadText: suspend (Selection) -> Unit,
    beforeChapter: suspend (Selection) -> Unit,
    shouldSkip: (Selection) -> Boolean = { false },
    shouldYield: () -> Boolean = { false },
    onUpdate: (DownloadBatchResult) -> Unit = {},
): DownloadBatchResult {
    var ready = 0
    val failures = mutableListOf<ChapterDownloadFailure>()
    fun result(stop: DownloadStop = DownloadStop.FINISHED) = DownloadBatchResult(ready, chapters.size, failures.toList(), stop)
    onUpdate(result())
    for (selection in chapters) {
        currentCoroutineContext().ensureActive()
        if (shouldSkip(selection)) continue
        if (shouldYield()) return result(DownloadStop.YIELD)
        beforeChapter(selection)
        try {
            if (!downloadAudio(selection)) return result(DownloadStop.STORAGE)
            ready++
            onUpdate(result())
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            currentCoroutineContext().ensureActive()
            failures.add(ChapterDownloadFailure(selection, DownloadPart.AUDIO, e.message ?: "Connection unavailable"))
            onUpdate(result())
            continue
        }
        try {
            downloadText(selection)
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            currentCoroutineContext().ensureActive()
            failures.add(ChapterDownloadFailure(selection, DownloadPart.TEXT, e.message ?: "Reading text unavailable"))
        }
        onUpdate(result())
    }
    return result()
}
