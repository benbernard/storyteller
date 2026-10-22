package com.crabanddog.listener

import android.content.SharedPreferences
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import org.json.JSONObject

@Composable
internal fun BookPage(book: Book?, source: JSONObject?, state: ListenerUiState, play: (Book) -> Unit, navigate: (String) -> Unit) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) { StoryCover(book?.id ?: source?.optString("id").orEmpty(), Modifier.size(64.dp, 92.dp)); Column { Text(book?.title ?: source?.optString("title").orEmpty(), style = MaterialTheme.typography.headlineSmall); Text(book?.author ?: source?.optString("author").orEmpty(), style = MaterialTheme.typography.bodyMedium) } } }
        item { if (book != null && book.editions.values.any { it.isNotEmpty() }) Button(onClick = { play(book) }, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Default.PlayArrow, null); Spacer(Modifier.width(8.dp)); Text(if (state.positions.any { it.optString("story") == book.id } || state.selection?.story == book.id) "Continue listening" else "Play book") } else { Button(onClick = {}, enabled = false, modifier = Modifier.fillMaxWidth()) { Text("Audio isn’t ready") }; Text("No audio is published yet. Play will be available when it is ready.", style = MaterialTheme.typography.bodySmall) } }
        source?.optString("description")?.takeIf { it.isNotBlank() }?.let { description -> item { Text(description, style = MaterialTheme.typography.bodyMedium) } }
        if (book != null) {
            val summary = listeningSummary(book, state)
            item { Text("${summary.unread} unplayed chapters · ${formatTime(summary.remaining)} left", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            item { PageLink("Chapters") { navigate("chapters") }; PageLink("Downloads") { navigate("downloads") } }
        }
        item { PageLink("Marked issues") { navigate("issues") }; PageLink("Audio preparation") { navigate("preparation") } }
    }
}
@Composable
private fun PageLink(label: String, click: () -> Unit) { HorizontalDivider(); TextButton(onClick = click, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text(label, modifier = Modifier.weight(1f)); Icon(Icons.Default.ChevronRight, null) } }

@Composable
internal fun ChaptersPage(book: Book?, state: ListenerUiState, browse: (Selection, Boolean) -> Unit, play: (Book, String, Chapter) -> Unit) {
    if (book == null) { Text("Chapters are unavailable.", Modifier.padding(20.dp)); return }
    val context = LocalContext.current
    val audio = remember(context) { OfflineAudio(context) }
    val edition = state.selection?.takeIf { it.story == book.id }?.edition ?: listeningSummary(book, state).edition
    var query by rememberSaveable { mutableStateOf("") }
    val available = book.editions[edition].orEmpty()
    val all = book.editions.values.flatten().distinctBy { it.id }.sortedBy { it.sequence }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { Text(book.title, style = MaterialTheme.typography.titleLarge); Text(editionName(edition), style = MaterialTheme.typography.labelMedium) }
        item { OutlinedTextField(query, { query = it }, label = { Text("Find a chapter") }, singleLine = true, modifier = Modifier.fillMaxWidth()) }
        item { Text("Tap a title to read. Use Play to listen.", style = MaterialTheme.typography.bodySmall) }
        items(all.map { candidate -> available.find { it.id == candidate.id } ?: candidate }.filter { "${it.sequence} ${it.title}".contains(query, true) }, key = { it.assembly }) { chapter ->
            val present = available.any { it.assembly == chapter.assembly }
            val current = state.selection?.chapter?.assembly == chapter.assembly
            val textEdition = if (present) edition else book.editions.entries.first { (_, list) -> list.any { it.assembly == chapter.assembly } }.key
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { browse(Selection(book.id, book.title, textEdition, chapter), present) }, modifier = Modifier.weight(1f)) { Column(Modifier.fillMaxWidth()) { Text(chapter.title, style = MaterialTheme.typography.titleSmall); Text(if (!present) "Audio isn’t ready in this edition" else if (state.offline && !audio.ready(chapter)) "Connect to play · not downloaded" else if (current) "Your place · ${formatTime(state.position)}" else if ("${book.id}:${chapter.id}" in state.completed) "Finished" else "Not started", style = MaterialTheme.typography.labelSmall) } }
                IconButton(onClick = { play(book, edition, chapter) }, enabled = present && (!state.offline || audio.ready(chapter))) { Icon(Icons.Default.PlayArrow, if (current) "Resume ${chapter.title}" else "Play ${chapter.title} from start") }
            }
            HorizontalDivider()
        }
    }
}

@Composable
private fun downloadRevision(audio: OfflineAudio): Int {
    var revision by remember { mutableIntStateOf(0) }
    DisposableEffect(audio) { val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> revision++ }; audio.prefs.registerOnSharedPreferenceChangeListener(listener); onDispose { audio.prefs.unregisterOnSharedPreferenceChangeListener(listener) } }
    return revision
}
@Composable
internal fun DownloadsPage(book: Book, audio: OfflineAudio, clear: () -> Unit) {
    val revision = downloadRevision(audio)
    val edition = remember(revision, book.id) { audio.prefs.getString("view-edition:${book.id}", book.defaultEdition).orEmpty().takeIf { it in book.editions } ?: book.editions.keys.firstOrNull().orEmpty() }
    val chapters = book.editions[edition].orEmpty()
    val count = remember(revision, chapters) { chapters.count(audio::ready) }
    val progress = remember(revision, edition) { audio.progress(book.id, edition) }
    val selected = remember(revision, edition) { audio.selected(book, edition) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(book.title, style = MaterialTheme.typography.titleLarge)
        Text("${editionName(edition)} · On this phone", style = MaterialTheme.typography.bodySmall)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { Text("Keep this edition offline", modifier = Modifier.weight(1f)); Switch(checked = selected, onCheckedChange = { if (it) audio.request(book.id, edition) else audio.pause(book.id, edition) }, modifier = Modifier.semantics { contentDescription = "Keep this edition offline" }) }
        Text("Includes new chapters as they’re published.", style = MaterialTheme.typography.bodySmall)
        Text("$count of ${chapters.size} chapters downloaded", style = MaterialTheme.typography.titleMedium)
        if (chapters.isNotEmpty()) LinearProgressIndicator(progress = { count.toFloat() / chapters.size }, modifier = Modifier.fillMaxWidth())
        Text(if (count == chapters.size && count > 0) "All published chapters downloaded" else if (audio.paused(book.id, edition)) "Downloads paused" else progress.optString("status", if (selected) "Waiting for a connection" else "Not downloading"), style = MaterialTheme.typography.bodyMedium)
        if (progress.optString("chapter").isNotBlank()) Text(progress.optString("chapter"), style = MaterialTheme.typography.bodySmall)
        val bytes = progress.optLong("bytes"); val total = progress.optLong("totalBytes", -1)
        if (bytes > 0) { Text(if (total > 0) "${bytes / 1048576} of ${total / 1048576} MB in this chapter" else "${bytes / 1024} KB in this chapter", style = MaterialTheme.typography.bodySmall); if (total > 0) LinearProgressIndicator(progress = { (bytes.toFloat() / total).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth()) }
        if (count < chapters.size || chapters.isEmpty()) TextButton(onClick = { audio.request(book.id, edition) }) { Text(if (progress.optBoolean("retry")) "Retry downloads" else if (audio.paused(book.id, edition)) "Resume downloads" else "Download audio") }
        if (selected) TextButton(onClick = { audio.pause(book.id, edition) }) { Text("Pause downloads") }
        HorizontalDivider()
        TextButton(onClick = clear, enabled = book.editions.values.flatten().any(audio::ready)) { Text("Clear this book’s downloads") }
    }
}
@Composable
internal fun DownloadSettings(book: Book, audio: OfflineAudio, dismiss: () -> Unit) {
    val context = LocalContext.current
    val revision = downloadRevision(audio)
    var edition by remember { mutableStateOf(audio.prefs.getString("view-edition:${book.id}", book.defaultEdition).orEmpty()) }
    val wifi = remember(revision) { audio.wifiOnly() }; val limit = remember(revision) { audio.limitGb() }
    AlertDialog(onDismissRequest = dismiss, title = { Text("Download settings") }, text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Edition to download", style = MaterialTheme.typography.labelLarge)
        book.editions.keys.forEach { value -> Row(verticalAlignment = Alignment.CenterVertically) { RadioButton(selected = edition == value, onClick = { edition = value; audio.prefs.edit().putString("view-edition:${book.id}", value).apply() }); Text(editionName(value)) } }
        Text("Listening stays on its current edition.", style = MaterialTheme.typography.bodySmall)
        HorizontalDivider(); Text("On this phone", style = MaterialTheme.typography.titleSmall)
        Row(verticalAlignment = Alignment.CenterVertically) { Text("Wi-Fi only", modifier = Modifier.weight(1f)); Switch(checked = wifi, onCheckedChange = { audio.prefs.edit().putBoolean("wifi", it).apply(); OfflineAudio.schedule(context, restart = true) }, modifier = Modifier.semantics { contentDescription = "Wi-Fi only" }) }
        Text("Download storage limit", style = MaterialTheme.typography.labelLarge)
        listOf(2, 8, 32).forEach { value -> Row(verticalAlignment = Alignment.CenterVertically) { RadioButton(selected = limit == value, onClick = { audio.prefs.edit().putInt("limit-gb", value).apply() }); Text("$value GB") } }
    } }, confirmButton = { TextButton(onClick = dismiss) { Text("Close") } })
}

@Composable
internal fun PreparationPage(book: Book?, source: JSONObject?, state: ListenerUiState, check: (String) -> Unit, job: (String, String) -> Unit, refresh: () -> Unit) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val work = source?.optJSONObject("job")
    val follow = source?.optJSONObject("follow")
    val chapters = jsonObjects(source?.optJSONArray("chapters"))
    val published = book?.editions?.get("qwen").orEmpty().size
    val mayWrite = state.canManage && state.canGenerate && !state.offline && source?.optBoolean("supported", true) == true
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(book?.title ?: source?.optString("title").orEmpty(), style = MaterialTheme.typography.titleLarge)
        Text("Qwen local · Audio preparation", style = MaterialTheme.typography.bodySmall)
        Text(if (chapters.isEmpty()) "$published chapters published" else "$published of ${chapters.size} chapters published", style = MaterialTheme.typography.titleMedium)
        if (chapters.isNotEmpty()) LinearProgressIndicator(progress = { (published.toFloat() / chapters.size).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
        Text("Published audio stays available while more is prepared.", style = MaterialTheme.typography.bodySmall)
        if (state.offline) Text("Offline · showing the last saved report", style = MaterialTheme.typography.bodySmall)
        if (source?.optBoolean("supported", true) == false) Text(source.optString("description", "This source does not support preparation."))
        if (work != null) {
            HorizontalDivider()
            val status = work.optString("status")
            Text(when { work.optBoolean("cancel") && status == "running" -> "Cancellation requested"; status == "cancelled" -> "Cancelled"; status == "complete" -> "Current job complete"; status == "failed" -> "Needs attention"; status == "queued" -> "Queued"; else -> work.optString("phase", status) }, style = MaterialTheme.typography.titleSmall)
            if (work.optString("phase").isNotBlank() && status in listOf("queued", "failed")) Text(work.optString("phase"), style = MaterialTheme.typography.bodySmall)
            if (work.optString("error").isNotBlank()) Text(work.optString("error"), style = MaterialTheme.typography.bodySmall)
            if (work.optString("status") in listOf("failed", "waiting", "cancelled")) TextButton(onClick = { job(work.getString("id"), "retry") }, enabled = mayWrite) { Text("Retry") }
            if (work.optString("status") in listOf("queued", "running", "waiting") && !work.optBoolean("cancel")) TextButton(onClick = { job(work.getString("id"), "cancel") }, enabled = mayWrite) { Text("Cancel job") }
        } else Text("No active preparation job", style = MaterialTheme.typography.bodySmall)
        if (chapters.isNotEmpty()) {
            TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Hide chapter status" else "Chapter status") }
            if (expanded) chapters.forEach { chapter -> Text(chapter.optString("title"), style = MaterialTheme.typography.bodyMedium); val editions = chapter.optJSONArray("editions"); Text(if ((0 until (editions?.length() ?: 0)).any { editions!!.optString(it) == "qwen" }) "Published" else "Not published yet", style = MaterialTheme.typography.labelSmall); HorizontalDivider() }
        }
        HorizontalDivider()
        Text("Automatic checks · ${if (follow?.optBoolean("enabled") == true) "Every ${follow.optInt("intervalHours", 6)} hours" else "Paused"}", style = MaterialTheme.typography.bodySmall)
        if (state.catalogReportedAt > 0) Text("Report received ${java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(state.catalogReportedAt))}", style = MaterialTheme.typography.labelSmall)
        TextButton(onClick = refresh, enabled = !state.loading && !state.offline) { Text("Refresh status") }
        if (follow != null) TextButton(onClick = { check(source.getString("id")) }, enabled = mayWrite) { Text("Check now") }
        source?.optJSONObject("repair")?.let { RepairStatusPanel(it) }
    }
}
@Composable
internal fun PreparationSettings(source: JSONObject, state: ListenerUiState, save: (String, Boolean, String) -> Unit, dismiss: () -> Unit) {
    val follow = source.optJSONObject("follow")
    var checks by remember { mutableStateOf(follow?.optBoolean("enabled") ?: false) }
    var mode by remember { mutableStateOf(follow?.optString("mode") ?: "buffer") }
    var awaiting by remember { mutableStateOf(false) }; var started by remember { mutableStateOf(false) }
    val id = source.getString("id"); val busy = id in state.updatingStories
    val allowed = state.canManage && !state.offline && source.optBoolean("supported", true) && follow != null
    LaunchedEffect(busy, awaiting, state.storyErrors[id]) { if (awaiting && busy) started = true; if (awaiting && started && !busy) { awaiting = false; if (state.storyErrors[id] == null) dismiss() } }
    AlertDialog(onDismissRequest = dismiss, title = { Text("Preparation settings") }, text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) { Text("Automatic checks", modifier = Modifier.weight(1f)); Switch(checks, { checks = it }, enabled = allowed && !busy, modifier = Modifier.semantics { contentDescription = "Automatic checks" }) }
        listOf("buffer" to "Next 5 unread chapters", "all" to "Every available chapter", "download" to "Text only").forEach { (value, label) -> Row(verticalAlignment = Alignment.CenterVertically) { RadioButton(selected = mode == value, onClick = { mode = value }, enabled = allowed && !busy && (state.canGenerate || value == "download")); Text(label) } }
        Text("Checks every 6 hours. Pausing checks leaves the current job running.", style = MaterialTheme.typography.bodySmall)
        if (follow == null) Text("Book setup is managed in an agent session.", style = MaterialTheme.typography.bodySmall)
        state.storyErrors[id]?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    } }, confirmButton = { TextButton(onClick = { awaiting = true; save(source.getString("url"), checks, mode) }, enabled = allowed && !busy && (state.canGenerate || mode == "download")) { Text(if (busy) "Saving…" else "Save settings") } }, dismissButton = { TextButton(onClick = dismiss) { Text("Close") } })
}

@Composable
internal fun IssuesPage(state: ListenerUiState, story: String?, resolve: (JSONObject) -> Unit) {
    val context = LocalContext.current
    val store = remember(context) { ListenerStore.get(context) }
    var filter by rememberSaveable { mutableStateOf("All") }
    val local = store.pendingIssues().filter { pending -> state.issues.none { it.optString("eventId") == pending.optString("eventId") } }
    val issues = (local + state.issues).filter { (story == null || it.optString("story") == story) && (filter == "All" || (filter == "Resolved") == (it.optString("status") == "resolved")) }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf("All", "Open", "Resolved").forEach { option -> FilterChip(selected = filter == option, onClick = { filter = option }, label = { Text(option) }) } } }
        if (state.offline) item { Text("Offline · saved reports", style = MaterialTheme.typography.bodySmall) }
        if (issues.isEmpty()) item { Text("No marked issues here.", style = MaterialTheme.typography.bodyMedium) }
        items(issues, key = { it.optString("id", it.optString("eventId")) }) { issue ->
            val resolved = issue.optString("status") == "resolved"; val pending = issue.optString("status") == "pending"
            Row(verticalAlignment = Alignment.CenterVertically) { Text(when (issue.optString("kind")) { "voice" -> "Wrong voice"; "pronunciation" -> "Pronunciation"; "missing" -> "Missing or repeated text"; "delivery" -> "Delivery or pacing"; else -> "Other" }, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f)); IconToggleButton(checked = resolved, onCheckedChange = { resolve(issue) }, enabled = state.canManage && !state.offline && !state.loading && !pending && issue.optString("id") !in state.resolvingIssues) { Icon(if (resolved) Icons.Default.CheckCircle else Icons.Default.CheckCircleOutline, if (resolved) "Reopen issue" else "Resolve issue") } }
            Text(state.books.find { it.id == issue.optString("story") }?.title ?: issue.optString("story"), style = MaterialTheme.typography.bodySmall)
            Text("${editionName(issue.optString("edition"))} · Chapter ${issue.optInt("sequence")} · ${formatTime(issue.optDouble("seconds"))}", style = MaterialTheme.typography.labelSmall)
            if (issue.optString("note").isNotBlank()) Text(issue.optString("note"), style = MaterialTheme.typography.bodyMedium)
            if (pending) Text("Saved on this phone · waiting to sync", style = MaterialTheme.typography.labelSmall)
            HorizontalDivider()
        }
    }
}

@Composable
internal fun AccountPage(state: ListenerUiState, store: ListenerStore, disconnect: () -> Unit, sync: () -> Unit, reviewDraft: (JSONObject) -> Unit = {}, pause: () -> Unit = {}) {
    var confirm by rememberSaveable { mutableStateOf(false) }
    var revision by remember { mutableIntStateOf(0) }
    DisposableEffect(store) { val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> revision++ }; store.observeSettings(listener); onDispose { store.stopObservingSettings(listener) } }
    val pending = remember(revision, state.loading) { store.hasPending() }
    val drafts = remember(revision) { store.drafts() }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("Your account", style = MaterialTheme.typography.titleLarge)
        if (state.accountLabel.isNotBlank()) Text(state.accountLabel, style = MaterialTheme.typography.bodyMedium)
        Text("Signed in on this phone", style = MaterialTheme.typography.bodySmall)
        Text(if (state.offline) "Offline · saved account" else if (pending) "Your latest work is waiting to sync" else "Your listening place is synced.", style = MaterialTheme.typography.bodySmall)
        if (confirm) {
            HorizontalDivider(); Text("Sign out on this phone?", style = MaterialTheme.typography.titleMedium)
            Text("Downloaded audio and cached account data on this phone will be removed. Synced progress and reports stay in your account.", style = MaterialTheme.typography.bodyMedium)
            if (drafts.isNotEmpty()) { Text("Finish or discard your marked-issue drafts first.", style = MaterialTheme.typography.bodySmall); TextButton(onClick = { reviewDraft(drafts.first()) }) { Text("Review draft") } }
            if (pending) TextButton(onClick = sync, enabled = !state.loading && !state.offline) { Text("Sync before signing out") }
            TextButton(onClick = disconnect, enabled = !pending && drafts.isEmpty() && !state.loading && !state.offline) { Text(if (state.loading) "Signing out…" else "Sign out") }
            TextButton(onClick = { confirm = false }) { Text("Stay signed in") }
        } else TextButton(onClick = { pause(); confirm = true }) { Text("Sign out") }
    }
}
