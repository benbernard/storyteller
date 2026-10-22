package com.crabanddog.listener

import android.content.SharedPreferences
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.selection.toggleable
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject

@Composable
internal fun BookPage(book: Book?, source: JSONObject?, state: ListenerUiState, play: (Book) -> Unit, navigate: (String) -> Unit) {
    val id = book?.id ?: source?.optString("id").orEmpty()
    val wide = androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp >= 700
    val ready = book != null && book.editions.values.any { it.isNotEmpty() }
    val summary = book?.let { listeningSummary(it, state) }
    LazyColumn(Modifier.fillMaxSize().testTag("book-content"), contentPadding = PaddingValues(horizontal = if (wide) 32.dp else 18.dp, vertical = 16.dp)) {
        item {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                StoryCover(id, Modifier.size(88.dp, 132.dp))
                Text(book?.title ?: source?.optString("title").orEmpty(), style = MaterialTheme.typography.titleLarge, textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.padding(top = 16.dp))
                Text(book?.author ?: source?.optString("author").orEmpty(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
            }
            Button(onClick = { book?.let(play) }, enabled = ready, shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth().padding(top = 24.dp, bottom = 24.dp).heightIn(min = 48.dp)) {
                if (ready) { Icon(Icons.Default.PlayArrow, null, Modifier.size(20.dp)); Spacer(Modifier.width(8.dp)) }
                Text(if (!ready) "Audio is preparing" else if (summary?.latest != null) "Continue listening" else "Play book")
            }
            if (!ready) Text("No audio is published yet. Play will be available when it is ready.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        source?.optString("description")?.takeIf { it.isNotBlank() }?.let { description -> item { Text(description, fontFamily = androidx.compose.ui.text.font.FontFamily.Serif, fontSize = 16.sp, lineHeight = 26.4.sp, modifier = Modifier.padding(bottom = 24.dp)) } }
        item {
            FactRow("Your place", book?.let { listeningPlace(it, state, summary?.latest) } ?: "Preparing audio")
            FactRow("Audio", if (ready) "${summary?.unread} unplayed chapters" else source?.optJSONObject("job")?.optString("phase")?.takeIf { it.isNotBlank() } ?: "Preparing audio")
            if (ready) FactRow("Remaining", formatRemaining(summary?.remaining ?: 0.0))
            Spacer(Modifier.height(16.dp))
            if (book != null && ready) { PageLink("Chapters") { navigate("chapters") }; PageLink("Downloads") { navigate("downloads") }; PageLink("Marked issues") { navigate("issues") } }
            PageLink("Audio preparation") { navigate("preparation") }
        }
    }
}
@Composable
private fun PageLink(label: String, click: () -> Unit) {
    TextButton(onClick = click, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), contentPadding = PaddingValues(vertical = 10.dp)) { Text(label, modifier = Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, fontSize = 14.4.sp); Icon(Icons.Default.ChevronRight, null, Modifier.size(18.dp)) }
}

@Composable
internal fun ChaptersPage(book: Book?, state: ListenerUiState, browse: (Selection, Boolean) -> Unit, play: (Book, String, Chapter) -> Unit) {
    if (book == null) { Text("Chapters are unavailable.", Modifier.padding(18.dp)); return }
    val context = LocalContext.current
    val wide = androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp >= 700
    val audio = remember(context) { OfflineAudio(context) }
    val summary = listeningSummary(book, state)
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    val edition = summary.edition
    var query by rememberSaveable { mutableStateOf("") }
    val available = book.editions[edition].orEmpty()
    val all = book.editions.values.flatten().distinctBy { it.id }.sortedBy { it.sequence }
    val matches = all.map { candidate -> available.find { it.id == candidate.id } ?: candidate }.filter { "${it.sequence} ${it.title}".contains(query, true) }
    LazyColumn(Modifier.widthIn(max = 664.dp).fillMaxSize().testTag("chapter-content"), contentPadding = PaddingValues(horizontal = if (wide) 32.dp else 18.dp, vertical = 16.dp)) {
        item { Text(book.title, fontSize = 17.92.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold); Text("Chapters · ${editionName(edition)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp, bottom = 20.dp)) }
        item { SearchField(query, { query = it }, "Find a chapter", "Chapter number or title", keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSearch = { keyboard?.hide() }), showIcon = false) }
        item { Text("Tap a title to read. Use Play to listen.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 10.dp, bottom = 16.dp)) }
        if (matches.isEmpty()) item { Text("No matching chapters.", style = MaterialTheme.typography.bodyMedium); TextButton(onClick = { query = "" }) { Text("Clear search") } }
        items(matches, key = { it.assembly }) { chapter ->
            val present = available.any { it.assembly == chapter.assembly }
            val current = summary.latest?.optString("assembly") == chapter.assembly
            val textEdition = if (present) edition else book.editions.entries.first { (_, list) -> list.any { it.assembly == chapter.assembly } }.key
            Surface(color = if (current) MaterialTheme.colorScheme.primaryContainer else androidx.compose.ui.graphics.Color.Transparent, shape = androidx.compose.foundation.shape.RoundedCornerShape(10.dp), modifier = Modifier.padding(vertical = 4.dp)) {
                Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { browse(Selection(book.id, book.title, textEdition, chapter), present) }, modifier = Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 4.dp, vertical = 10.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
                            Text("${chapter.sequence}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.widthIn(min = 26.dp))
                            Column(Modifier.weight(1f)) {
                                Text(chapter.title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurface)
                                Text(if (!present) "Audio unavailable in this edition" else if (state.offline && !audio.ready(chapter)) "Internet needed" else if (current) "Your place · ${formatTime(chapterView(chapter, state.reading, state.includeAuthorNotes).position(summary.latest?.optDouble("seconds") ?: 0.0))}" else if ("${book.id}:${chapter.id}" in state.completed) "Finished" else "Not started", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 5.dp))
                            }
                        }
                    }
                    IconButton(onClick = { play(book, edition, chapter) }, enabled = present && (!state.offline || audio.ready(chapter))) { Icon(Icons.Default.PlayArrow, if (current) "Resume ${chapter.title}" else "Play ${chapter.title} from start", Modifier.size(22.dp), tint = MaterialTheme.colorScheme.primary) }
                }
            }
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
    val wide = androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp >= 700
    val edition = remember(revision, book.id) { audio.prefs.getString("view-edition:${book.id}", book.defaultEdition).orEmpty().takeIf { it in book.editions } ?: book.editions.keys.firstOrNull().orEmpty() }
    val chapters = book.editions[edition].orEmpty()
    val count = remember(revision, chapters) { chapters.count(audio::ready) }
    val progress = remember(revision, edition) { audio.progress(book.id, edition) }
    val kept = remember(revision, edition) { audio.kept(book, edition) }
    val downloadedBytes by produceState<Long?>(null, revision, chapters) { value = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { audio.savedBytes(chapters) } }
    val paused = audio.paused(book.id, edition)
    val bytes = progress.optLong("bytes"); val total = progress.optLong("totalBytes", -1)
    val complete = count == chapters.size && count > 0
    val status = when { complete -> "All published chapters downloaded"; !kept -> if (count > 0) "Downloads paused" else "Not downloading"; paused -> "Downloads paused"; progress.optBoolean("retry") -> "One chapter couldn’t download"; else -> progress.optString("status", "Waiting for a connection") }
    Column(Modifier.widthIn(max = 664.dp).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = if (wide) 32.dp else 18.dp, vertical = 16.dp)) {
        BookIdentity(book.id, book.title, "${editionName(edition)} · On this phone")
        HorizontalDivider(); Spacer(Modifier.height(16.dp))
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(value = kept, role = androidx.compose.ui.semantics.Role.Checkbox, onValueChange = { if (it) audio.request(book.id, edition) else { audio.select(book, edition, false); audio.pause(book.id, edition) } }).semantics { contentDescription = "Keep this edition offline" }, verticalAlignment = Alignment.CenterVertically) {
            Text("Keep this edition offline", modifier = Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, fontSize = 14.4.sp)
            Checkbox(checked = kept, onCheckedChange = null, modifier = Modifier.size(20.dp))
        }
        Text("Includes new chapters as they’re published.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 22.dp))
        Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp), modifier = Modifier.padding(bottom = 24.dp)) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 18.dp)) {
                Text("$count of ${chapters.size} chapters", fontSize = 18.88.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
                Text("${downloadedBytes?.let { formatBytes(it) + " downloaded" } ?: "Calculating downloaded size…"} · ${if (audio.wifiOnly()) "Wi-Fi only" else "Any connection"}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
            }
        }
        SectionTitle(status)
        if (progress.optString("chapter").isNotBlank()) Text(progress.optString("chapter"), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 10.dp))
        if (bytes > 0 && !paused && kept) {
            if (total > 0) DesignProgress((bytes.toFloat() / total).coerceIn(0f, 1f), Modifier.fillMaxWidth().padding(top = 10.dp))
            Text(if (total > 0) "${formatBytes(bytes).substringBeforeLast(" ")} of ${formatBytes(total)} · ${(bytes * 100.0 / total).toInt().coerceIn(0, 100)}%" else formatBytes(bytes), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
        } else Text(when { complete -> "Ready to listen without a connection."; status.contains("Wi-Fi") -> "Downloaded chapters are available. Connect to Wi-Fi or change Download settings."; status.contains("limit", true) -> "Downloaded chapters are available. Increase the limit in Download settings to continue."; progress.optBoolean("retry") -> "Other chapters finished. Retry to continue this download."; count > 0 -> "Your downloaded chapters stay on this phone."; else -> "Stream now, or keep this edition for offline listening." }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 10.dp))
        if (!complete) TextButton(onClick = { if (kept && !paused && !progress.optBoolean("retry")) audio.pause(book.id, edition) else audio.request(book.id, edition) }, contentPadding = PaddingValues(horizontal = 0.dp)) { Text(if (progress.optBoolean("retry")) "Retry downloads" else if (kept && !paused) "Pause downloads" else if (count > 0 || paused) "Resume downloads" else "Download audio") }
        Spacer(Modifier.height(24.dp))
        TextButton(onClick = clear, enabled = audio.hasBookDownloads(book), contentPadding = PaddingValues(horizontal = 0.dp)) { Text("Clear this book’s downloads") }
    }
}
@Composable
internal fun DownloadSettings(book: Book, audio: OfflineAudio, dismiss: () -> Unit) {
    val context = LocalContext.current
    val revision = downloadRevision(audio)
    var edition by remember { mutableStateOf(audio.prefs.getString("view-edition:${book.id}", book.defaultEdition).orEmpty().takeIf { it in book.editions } ?: book.editions.keys.first()) }
    val wifi = remember(revision) { audio.wifiOnly() }; val limit = remember(revision) { audio.limitGb() }
    ListenerSheet("Download settings", dismiss) {
        ChoiceField("Edition to download", editionName(edition), book.editions.keys.map { it to editionName(it) }, edition) { value -> edition = value; audio.prefs.edit().putString("view-edition:${book.id}", value).apply() }
        Text("Listening stays on its current edition.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
        HorizontalDivider(Modifier.padding(top = 20.dp, bottom = 18.dp)); Text("On this phone", fontSize = 12.8.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
        Row(Modifier.fillMaxWidth().padding(top = 6.dp, bottom = 16.dp).heightIn(min = 48.dp).toggleable(value = wifi, role = androidx.compose.ui.semantics.Role.Checkbox, onValueChange = { audio.prefs.edit().putBoolean("wifi", it).apply(); OfflineAudio.schedule(context, restart = true) }).semantics { contentDescription = "Wi-Fi only" }, verticalAlignment = Alignment.CenterVertically) { Text("Wi-Fi only", modifier = Modifier.weight(1f), style = MaterialTheme.typography.labelLarge); Checkbox(wifi, null, modifier = Modifier.size(20.dp)) }
        ChoiceField("Download storage limit", "$limit GB", listOf(2, 8, 32).map { it.toString() to "$it GB" }, limit.toString()) { value -> audio.prefs.edit().putInt("limit-gb", value.toInt()).apply(); OfflineAudio.schedule(context, restart = true) }
    }
}

@Suppress("UNUSED_PARAMETER")
@Composable
internal fun PreparationPage(book: Book?, source: JSONObject?, state: ListenerUiState, check: (String) -> Unit, job: (String, String) -> Unit, refresh: () -> Unit) {
    val wide = androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp >= 700
    var expanded by rememberSaveable { mutableStateOf(false) }
    val work = source?.optJSONObject("job")
    val follow = source?.optJSONObject("follow")
    val chapters = jsonObjects(source?.optJSONArray("chapters"))
    val published = book?.editions?.get("qwen").orEmpty().size
    val supported = source?.optBoolean("supported", true) == true
    val mayWrite = state.canManage && state.canGenerate && !state.offline && supported && source?.optString("id") !in state.updatingStories
    Column(Modifier.widthIn(max = 664.dp).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = if (wide) 32.dp else 18.dp, vertical = 16.dp)) {
        BookIdentity(book?.id ?: source?.optString("id").orEmpty(), book?.title ?: source?.optString("title").orEmpty(), "Qwen local · Audio preparation")
        if (state.message.isNotBlank() && state.message != "Your progress is synced." && !state.message.startsWith("Issue saved at")) Text(state.message, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(bottom = 14.dp))
        if (state.offline) Text("Offline. This is the last saved status; the server job may still be running.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(bottom = 14.dp))
        else if (!state.canManage) Text("You can view status. Managing preparation requires library access.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(bottom = 14.dp))
        if (!supported) Text(source?.optString("description")?.takeIf { it.isNotBlank() } ?: "Audio preparation is not available for this source.", style = MaterialTheme.typography.bodyMedium)
        else {
            Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp)) {
                Column(Modifier.fillMaxWidth().padding(16.dp)) {
                    Text(if (chapters.isEmpty()) "$published chapters published" else "$published of ${chapters.size} chapters published", fontSize = 15.36.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
                    if (chapters.isNotEmpty()) DesignProgress((published.toFloat() / chapters.size).coerceIn(0f, 1f), Modifier.fillMaxWidth().padding(top = 14.dp))
                    Text(if (chapters.isNotEmpty() && published >= chapters.size) "Ready to listen in Qwen local." else "Published audio is available while the rest is prepared.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 10.dp))
                }
            }
            Column(Modifier.padding(top = 24.dp, bottom = 12.dp)) {
                val status = work?.optString("status").orEmpty()
                val cancelling = work?.optBoolean("cancel") == true && status in listOf("queued", "running", "waiting")
                SectionTitle(when { cancelling -> "Cancellation requested"; status == "cancelled" -> "Preparation cancelled"; status == "complete" -> "Audio published"; status == "failed" -> "Preparation stopped"; status == "queued" -> "Queued"; status == "waiting" -> "Waiting to retry"; status == "publishing" || work?.optString("phase")?.contains("publishing", ignoreCase = true) == true -> "Publishing audio"; status == "running" -> "Preparing audio"; else -> "No active preparation job" })
                Text(when { cancelling -> "Stops after the current passage."; work?.optString("error")?.isNotBlank() == true -> work.optString("error"); status == "cancelled" -> "Published chapters remain available."; status == "complete" -> "Published chapters are ready to listen."; work?.optString("phase")?.isNotBlank() == true -> work.optString("phase"); status == "queued" -> "Waiting to start."; else -> "Published audio remains available." }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 10.dp))
                if (work != null && !cancelling && status in listOf("failed", "waiting", "cancelled")) TextButton(onClick = { job(work.getString("id"), "retry") }, enabled = mayWrite, contentPadding = PaddingValues(0.dp)) { Text(if (status == "waiting") "Retry now" else "Retry preparation") }
                if (work != null && status in listOf("queued", "running", "waiting") && !cancelling) TextButton(onClick = { job(work.getString("id"), "cancel") }, enabled = mayWrite, contentPadding = PaddingValues(0.dp)) { Text("Cancel job", fontWeight = androidx.compose.ui.text.font.FontWeight.Normal) }
            }
            if (chapters.isNotEmpty()) {
                TextButton(onClick = { expanded = !expanded }, modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(0.dp)) { Text("Chapter status", fontWeight = androidx.compose.ui.text.font.FontWeight.Normal, modifier = Modifier.weight(1f)); Icon(if (expanded) Icons.Default.Remove else Icons.Default.Add, null, Modifier.size(18.dp)) }
                if (expanded) chapters.forEach { chapter ->
                    val editions = chapter.optJSONArray("editions")
                    val ready = (0 until (editions?.length() ?: 0)).any { editions!!.optString(it) == "qwen" }
                    FactRow(chapter.optString("title"), if (ready) "Published" else "Not published yet")
                }
                Spacer(Modifier.height(22.dp))
            }
            HorizontalDivider(); Spacer(Modifier.height(18.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) { Text("Automatic checks", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f)); Text(if (follow?.optBoolean("enabled") == true) "Every ${follow.optInt("intervalHours", 6)} hours" else "Paused", style = MaterialTheme.typography.bodySmall) }
        }
        val checked = source?.optString("checkedAt")?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() }
        if (checked != null || state.catalogReportedAt > 0) Text("${if (checked != null) "Last checked" else "Report received"} ${java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(checked ?: state.catalogReportedAt))}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 16.dp))
        source?.optString("id")?.let { state.storyErrors[it] }?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 10.dp)) }
        TextButton(onClick = refresh, enabled = !state.loading && !state.offline, contentPadding = PaddingValues(0.dp)) { Text("Refresh status", fontWeight = androidx.compose.ui.text.font.FontWeight.Normal) }
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
    ListenerSheet("Preparation settings", dismiss) {
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(checks, enabled = allowed && !busy, role = androidx.compose.ui.semantics.Role.Checkbox, onValueChange = { checks = it }).semantics { contentDescription = "Automatic checks" }, verticalAlignment = Alignment.CenterVertically) { Text("Automatic checks", style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f)); Checkbox(checks, null, enabled = allowed && !busy, modifier = Modifier.size(20.dp)) }
        Spacer(Modifier.height(24.dp))
        val modes = listOf("buffer" to "Next 5 unread chapters", "all" to "Every available chapter", "download" to "Text only").filter { state.canGenerate || it.first == "download" || it.first == mode }
        ChoiceField("Prepare", modes.find { it.first == mode }?.second ?: mode, modes.filter { state.canGenerate || it.first == "download" }, mode, enabled = allowed && !busy) { mode = it }
        Text("Checks every 6 hours. Pausing checks leaves the current job running.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(vertical = 16.dp))
        if (follow == null) Text("Book setup is managed in an agent session.", style = MaterialTheme.typography.bodySmall)
        if (state.offline) Text("Connect to change settings.", style = MaterialTheme.typography.bodySmall)
        else if (!state.canManage) Text("This account can view settings.", style = MaterialTheme.typography.bodySmall)
        state.storyErrors[id]?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        Button(onClick = { awaiting = true; save(source.getString("url"), checks, mode) }, enabled = allowed && !busy && (state.canGenerate || mode == "download"), shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp), modifier = Modifier.heightIn(min = 48.dp), contentPadding = PaddingValues(horizontal = 12.dp)) { Text(if (busy) "Saving…" else "Save settings", fontWeight = androidx.compose.ui.text.font.FontWeight.Normal) }
    }
}

@Composable
internal fun IssuesPage(state: ListenerUiState, story: String?, resolve: (JSONObject) -> Unit) {
    val context = LocalContext.current
    val store = remember(context) { ListenerStore.get(context) }
    val wide = androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp >= 700
    var filter by rememberSaveable { mutableStateOf("All") }
    var selectedStory by rememberSaveable(story) { mutableStateOf(story.orEmpty()) }
    val local = store.pendingIssues().filter { pending -> state.issues.none { it.optString("eventId") == pending.optString("eventId") } }
    val issues = (local + state.issues.sortedByDescending { it.optString("createdAt") }).filter { (selectedStory.isEmpty() || it.optString("story") == selectedStory) && (filter == "All" || (filter == "Resolved") == (it.optString("status") == "resolved")) }
    LazyColumn(Modifier.widthIn(max = 704.dp).fillMaxSize(), contentPadding = PaddingValues(horizontal = if (wide) 32.dp else 18.dp, vertical = 16.dp)) {
        item { ChoiceField("Book", state.books.find { it.id == selectedStory }?.title ?: "All books", listOf("" to "All books") + state.books.map { it.id to it.title }, selectedStory) { selectedStory = it }; FilterTabs(listOf("All", "Open", "Resolved"), filter) { filter = it }; Text("${issues.size} ${if (issues.size == 1) "report" else "reports"}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp, bottom = 4.dp)) }
        if (state.message.isNotBlank() && state.message != "Your progress is synced.") item { Text(state.message, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(vertical = 10.dp)) }
        else if (state.offline) item { Text("Offline · saved reports", style = MaterialTheme.typography.bodySmall) }
        if (!state.canManage) item { Text("You can view reports. Updating them requires library access.", style = MaterialTheme.typography.bodySmall) }
        if (issues.isEmpty()) item { Text("No marked issues here.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 24.dp)) }
        items(issues, key = { it.optString("id", it.optString("eventId")) }) { issue ->
            val resolved = issue.optString("status") == "resolved"; val pending = issue.optString("status") == "pending"
            Column(Modifier.padding(vertical = 12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) { Text(when (issue.optString("kind")) { "voice" -> "Voice or speaker"; "pronunciation" -> "Pronunciation"; "missing" -> "Missing or repeated text"; "delivery" -> "Delivery or pacing"; else -> "Something else" }, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f)); Box(Modifier.size(48.dp, 28.dp)) { IconToggleButton(checked = resolved, onCheckedChange = { resolve(issue) }, enabled = state.canManage && !state.offline && !state.loading && !pending && issue.optString("id") !in state.resolvingIssues, modifier = Modifier.requiredSize(48.dp).offset(y = (-10).dp)) { Icon(if (resolved) Icons.Default.CheckCircle else Icons.Default.CheckCircleOutline, if (resolved) "Reopen issue" else "Resolve issue", Modifier.size(22.dp), tint = MaterialTheme.colorScheme.primary) } } }
                Text(state.books.find { it.id == issue.optString("story") }?.title ?: issue.optString("story"), style = MaterialTheme.typography.bodySmall, fontWeight = androidx.compose.ui.text.font.FontWeight.Medium, modifier = Modifier.padding(top = 8.dp, bottom = 4.dp))
                val chapter = state.books.find { it.id == issue.optString("story") }?.editions?.get(issue.optString("edition"))?.find { it.assembly == issue.optString("assembly") || it.id == issue.optString("chapterId") || it.sequence == issue.optInt("sequence") }
                Text("Chapter ${issue.optInt("sequence")}" + (chapter?.title?.let { " · $it" } ?: ""), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
                Text("${editionName(issue.optString("edition"))} · ${formatTime(issue.optDouble("seconds"))}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp))
                if (issue.optString("note").isNotBlank()) Text(issue.optString("note"), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 10.dp))
                if (issue.optString("excerpt").isNotBlank()) Text(issue.optString("excerpt"), fontFamily = androidx.compose.ui.text.font.FontFamily.Serif, fontSize = 13.6.sp, lineHeight = 22.4.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
                state.issueErrors[issue.optString("id")]?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 10.dp)) }
                if (pending) Text("Saved on this phone · waiting to sync", style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 8.dp))
            }
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
    androidx.activity.compose.BackHandler(enabled = confirm) { confirm = false }
    Column(Modifier.widthIn(max = 500.dp).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 38.dp, vertical = 40.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("Your account", fontSize = 22.4.sp, lineHeight = 29.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
        if (state.accountLabel.isNotBlank()) Text(state.accountLabel, fontSize = 14.4.sp, lineHeight = 21.6.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
        Text("Signed in on this phone", style = MaterialTheme.typography.bodySmall)
        if (!confirm) Text(if (state.offline) "Offline · saved account" else if (pending) "Your latest work is waiting to sync" else "Your listening place is synced.", style = MaterialTheme.typography.bodySmall)
        if (confirm) {
            HorizontalDivider(); Text("Sign out on this phone?", style = MaterialTheme.typography.titleMedium)
            Text("Downloaded audio and cached account data on this phone will be removed. Synced progress and reports stay in your account.", fontSize = 13.76.sp, lineHeight = 22.4.sp)
            if (drafts.isNotEmpty()) { Text("Finish or discard your marked-issue drafts first.", style = MaterialTheme.typography.bodySmall); TextButton(onClick = { reviewDraft(drafts.first()) }) { Text("Review draft") } }
            if (pending) TextButton(onClick = sync, enabled = !state.loading && !state.offline) { Text("Sync before signing out") }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { confirm = false }, enabled = !state.loading, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)) { Text("Stay signed in", fontWeight = androidx.compose.ui.text.font.FontWeight.Normal) }
                Button(onClick = disconnect, enabled = !pending && drafts.isEmpty() && !state.loading && !state.offline, shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp), modifier = Modifier.heightIn(min = 48.dp), contentPadding = PaddingValues(horizontal = 14.dp)) { Text(if (state.loading) "Signing out…" else "Sign out", fontWeight = androidx.compose.ui.text.font.FontWeight.Normal) }
            }
            if (state.offline) Text("Connect to the internet before signing out.", style = MaterialTheme.typography.bodySmall)
        } else TextButton(onClick = { pause(); confirm = true }, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)) { Text("Sign out", fontWeight = androidx.compose.ui.text.font.FontWeight.Normal) }
        if (state.message.isNotBlank() && state.message != "Your progress is synced." && !state.message.startsWith("Issue saved at")) Text(state.message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
    }
}
