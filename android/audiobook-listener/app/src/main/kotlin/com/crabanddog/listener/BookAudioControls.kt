package com.crabanddog.listener

import android.content.SharedPreferences
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import org.json.JSONObject

/** Account generation and this phone's downloads have separate controls and progress. */
@Composable
fun BookAudioControls(story: String, source: JSONObject?, book: Book?, edition: String,
    updating: Boolean, error: String?, onAudio: (String, Boolean) -> Unit, onJob: (String, String) -> Unit) {
    val context = LocalContext.current
    val audio = remember(context) { OfflineAudio(context) }
    var revision by remember { mutableIntStateOf(0) }
    DisposableEffect(audio) {
        val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> revision++ }
        audio.prefs.registerOnSharedPreferenceChangeListener(listener)
        onDispose { audio.prefs.unregisterOnSharedPreferenceChangeListener(listener) }
    }
    val follow = source?.optJSONObject("follow")
    val enabled = follow?.let { it.optBoolean("enabled") && it.optString("mode") != "download" } == true
    val job = source?.optJSONObject("job")
    val generated = book?.editions?.get("qwen").orEmpty().size
    val total = source?.optJSONArray("chapters")?.length() ?: 0
    OutlinedCard(Modifier.fillMaxWidth().testTag("book-audio-controls")) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Audiobook", style = MaterialTheme.typography.titleLarge)
            if (source != null) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text("Generate audiobook", style = MaterialTheme.typography.titleMedium)
                        Text("Prepare local audio for this book.", style = MaterialTheme.typography.bodySmall)
                    }
                    Switch(checked = enabled, onCheckedChange = { onAudio(story, it) }, enabled = !updating && source.optBoolean("supported", true),
                        modifier = Modifier.semantics { contentDescription = "Generate audiobook" })
                }
                if (updating) Text("Saving audiobook setting…", style = MaterialTheme.typography.bodySmall)
                if (error != null) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                if (!source.optBoolean("supported", true)) Text(source.optString("description", "Choose an EPUB or a PDF with selectable text."))
                Text(if (total > 0) "$generated of $total chapters generated" else "$generated chapters generated", style = MaterialTheme.typography.bodyMedium)
                if (total > 0) LinearProgressIndicator(progress = { (generated.toFloat() / total).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                if (!enabled) Text("Generation is off. Finished audio is kept.", style = MaterialTheme.typography.bodySmall)
                if (job != null && job.optString("status") !in listOf("complete", "cancelled")) {
                    Text(job.optString("phase"), style = MaterialTheme.typography.bodyMedium)
                    if (job.optString("error").isNotBlank()) Text(job.getString("error"), color = MaterialTheme.colorScheme.error)
                    if (job.optString("status") in listOf("failed", "waiting") && enabled) {
                        OutlinedButton(onClick = { onJob(job.getString("id"), "retry") }) { Text("Retry generation") }
                    }
                    if (job.optBoolean("cancel")) Text("Stopping after the current passage…", style = MaterialTheme.typography.bodySmall)
                }
            }
            HorizontalDivider()
            val selectedEdition = edition.ifBlank { "qwen" }
            val chapters = book?.editions?.get(selectedEdition).orEmpty()
            val ready = remember(revision, chapters) { chapters.count(audio::ready) }
            val paused = remember(revision, story, selectedEdition) { !audio.enabled() || audio.paused(story, selectedEdition) }
            val progress = remember(revision, story, selectedEdition) { audio.progress(story, selectedEdition) }
            val selected = book?.let { audio.selected(it, selectedEdition) } ?: audio.requested(story, selectedEdition)
            Text("On this phone", style = MaterialTheme.typography.titleMedium)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("Keep this edition offline", Modifier.weight(1f))
                Switch(checked = selected, onCheckedChange = { if (it) audio.request(story, selectedEdition) else audio.pause(story, selectedEdition) },
                    modifier = Modifier.semantics { contentDescription = "Keep ${book?.title ?: source?.optString("title").orEmpty()}, ${editionName(selectedEdition)}, offline" })
            }
            Text("$ready of ${chapters.size} chapters downloaded", style = MaterialTheme.typography.bodyMedium)
            Text(if (audio.wifiOnly()) "Downloads use Wi-Fi only." else "Downloads can use mobile data.", style = MaterialTheme.typography.bodySmall)
            val status = if (paused) "Downloads paused" else progress.optString("status")
            if (status.isNotBlank()) Text(status, style = MaterialTheme.typography.bodyMedium)
            if (status == "Downloading audio") {
                Text(progress.optString("chapter"), style = MaterialTheme.typography.bodySmall)
                val bytes = progress.optLong("bytes")
                val expected = progress.optLong("totalBytes", -1)
                if (expected > 0) {
                    val fraction = (bytes.toFloat() / expected).coerceIn(0f, 1f)
                    Text("${(fraction * 100).toInt()}% of current chapter", style = MaterialTheme.typography.bodySmall)
                    LinearProgressIndicator(progress = { fraction }, modifier = Modifier.fillMaxWidth())
                } else Text("${bytes / 1024} KB downloaded", style = MaterialTheme.typography.bodySmall)
            } else if (chapters.isNotEmpty()) LinearProgressIndicator(progress = { ready.toFloat() / chapters.size }, modifier = Modifier.fillMaxWidth())
            if (chapters.isEmpty()) Text("Audio will download as chapters become ready.", style = MaterialTheme.typography.bodySmall)
            val needsRetry = progress.optBoolean("retry")
            if (paused || needsRetry || ready < chapters.size || chapters.isEmpty()) {
                OutlinedButton(onClick = { audio.request(story, selectedEdition) }, modifier = Modifier.fillMaxWidth()) {
                    Text(if (paused) "Resume downloads" else if (needsRetry) "Retry downloads" else "Download audio")
                }
            }
            if (!paused && selected) {
                TextButton(onClick = { audio.pause(story, selectedEdition) }, modifier = Modifier.fillMaxWidth()) { Text("Pause downloads") }
            }
        }
    }
}
