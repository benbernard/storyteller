package com.crabanddog.listener

import android.content.SharedPreferences
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@Composable
private fun downloadRevision(audio: OfflineAudio): Int {
    var revision by remember { mutableIntStateOf(0) }
    DisposableEffect(audio) {
        val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> revision++ }
        audio.prefs.registerOnSharedPreferenceChangeListener(listener)
        onDispose { audio.prefs.unregisterOnSharedPreferenceChangeListener(listener) }
    }
    return revision
}

@Composable
private fun DownloadProgress(audio: OfflineAudio, revision: Int) {
    val status = remember(revision) { audio.status() }
    val ready = remember(revision) { audio.prefs.getInt("ready", 0) }
    val total = remember(revision) { audio.prefs.getInt("total", 0) }
    val bytes = remember(revision) { audio.prefs.getLong("bytes", 0) }
    val size = remember(revision) { audio.prefs.getLong("size", 0) }
    Text(status, style = MaterialTheme.typography.bodySmall)
    if (total > 0) {
        Text("$ready of $total chapters saved", style = MaterialTheme.typography.labelLarge)
        LinearProgressIndicator(progress = { ready.toFloat() / total }, modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Saved chapters" })
    }
    if (bytes > 0 && audio.enabled()) {
        val downloaded = "%.1f".format(bytes / 1048576.0)
        Text(if (size > 0) "$downloaded of ${"%.1f".format(size / 1048576.0)} MB in this chapter" else "$downloaded MB in this chapter", style = MaterialTheme.typography.bodySmall)
        if (size > 0) LinearProgressIndicator(progress = { (bytes.toFloat() / size).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Current chapter download" })
    }
}

@Composable
fun OfflineDownloadsPanel(books: List<Book>) {
    val context = LocalContext.current
    val audio = remember(context) { OfflineAudio(context) }
    var expanded by rememberSaveable { mutableStateOf(false) }
    var confirmClear by remember { mutableStateOf(false) }
    val revision = downloadRevision(audio)
    val enabled = remember(revision) { audio.enabled() }
    val wifi = remember(revision) { audio.wifiOnly() }
    val limit = remember(revision) { audio.limitGb() }
    if (confirmClear) AlertDialog(onDismissRequest = { confirmClear = false }, title = { Text("Clear downloaded audio?") }, text = { Text("Downloads will pause. You will need a connection to download these chapters again.") }, confirmButton = { TextButton(onClick = { audio.clear(); confirmClear = false }) { Text("Clear downloads") } }, dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("Keep downloads") } })
    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Offline listening", style = MaterialTheme.typography.titleMedium)
            DownloadProgress(audio, revision)
            Button(onClick = { audio.downloadAll(books) }, enabled = books.any { it.editions.values.any { chapters -> chapters.isNotEmpty() } }, modifier = Modifier.fillMaxWidth()) { Text("Download all available") }
            Text("Saves every published chapter in every edition. For one book, open it in Library and choose Download audio.", style = MaterialTheme.typography.bodySmall)
            OutlinedButton(onClick = { if (enabled) audio.pause() else audio.resume() }, modifier = Modifier.fillMaxWidth()) { Text(if (enabled) "Pause downloads" else "Resume downloads") }
            if (enabled) TextButton(onClick = { audio.resume() }) { Text("Retry downloads now") }
            Text(if (wifi) "Wi-Fi only · $limit GB limit" else "Wi-Fi or mobile data · $limit GB limit", style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Hide settings" else "Downloads") }
            if (expanded) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    Text("Wi-Fi only", Modifier.weight(1f))
                    Switch(checked = wifi, onCheckedChange = { audio.prefs.edit().putBoolean("wifi", it).apply(); OfflineAudio.schedule(context, restart = true) }, modifier = Modifier.semantics { contentDescription = "Wi-Fi only" })
                }
                Text("Turn off Wi-Fi only to download over mobile data. Selected editions also download new published chapters automatically while downloads are enabled.", style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(2, 8, 32).forEach { gb -> FilterChip(selected = limit == gb, onClick = { audio.prefs.edit().putInt("limit-gb", gb).apply(); OfflineAudio.schedule(context, restart = true) }, label = { Text("$gb GB") }) }
                }
                Text("This saves existing audio. Open a book in Library to turn on generation and see its progress.", style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { confirmClear = true }) { Text("Clear downloads") }
            }
        }
    }
}
