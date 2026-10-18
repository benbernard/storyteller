package com.crabanddog.listener

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.Image
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import android.graphics.BitmapFactory
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.background
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.LibraryBooks
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.json.JSONObject

@Composable
fun ListenerScreen(state: ListenerUiState, onConnect: () -> Unit, onRefresh: () -> Unit,
    onDisconnect: () -> Unit = {}, onPlay: (Book, String, Chapter) -> Unit, onToggle: () -> Unit, onSeek: (Double) -> Unit,
    onSpeed: (Float) -> Unit, onIssue: (Selection, Double, String, String) -> Unit, onFinished: () -> Unit,
    onResolve: (JSONObject) -> Unit, onCharacters: (String) -> Unit, onPassage: (Double) -> Unit = onSeek,
    onHistory: (Boolean) -> Unit = {}, onReturn: (JSONObject) -> Unit = {},
    onFollow: (String, Boolean, String) -> Unit = { _, _, _ -> }, onCheck: (String) -> Unit = {}, onJob: (String, String) -> Unit = { _, _ -> }, onAudio: (String, Boolean) -> Unit = { _, _ -> }, onIncludeAuthorNotes: (Boolean) -> Unit = {}) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var storyId by rememberSaveable { mutableStateOf<String?>(null) }
    BackHandler(enabled = state.connected && (tab != 0 || storyId != null)) {
        when (tab) { 1 -> { storyId = state.selection?.story; tab = 0 }; 2, 3 -> tab = 4; else -> { storyId = null; tab = 0 } }
    }
    var issueAt by rememberSaveable { mutableStateOf<Double?>(null) }
    var issueSelection by rememberSaveable { mutableStateOf<String?>(null) }
    var showCharacters by rememberSaveable { mutableStateOf(false) }
    BoxWithConstraints(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).safeDrawingPadding()) {
    val expanded = maxWidth >= 760.dp
    val destinations = listOf(Triple(0, "Library", Icons.AutoMirrored.Filled.LibraryBooks), Triple(1, "Listening", Icons.Default.Headphones), Triple(4, "Tools", Icons.Default.Tune))
    val navigate: (Int) -> Unit = { tab = it; if (it == 0) storyId = null }
    Row(Modifier.fillMaxSize()) {
        if (expanded && state.connected) NavigationRail {
            Spacer(Modifier.height(16.dp))
            StorytellerMark(48.dp)
            Spacer(Modifier.height(24.dp))
            destinations.forEach { (index, label, icon) -> NavigationRailItem(selected = (tab == index || (index == 4 && tab in listOf(2, 3))), onClick = { navigate(index) }, icon = { Icon(icon, null) }, label = { Text(label) }, modifier = Modifier.padding(vertical = 4.dp)) }
        }
        Scaffold(modifier = Modifier.weight(1f), bottomBar = {
            if (state.connected && !expanded) NavigationBar {
                destinations.forEach { (index, label, icon) -> NavigationBarItem(selected = (tab == index || (index == 4 && tab in listOf(2, 3))), onClick = { navigate(index) }, icon = { Icon(icon, null) }, label = { Text(label, maxLines = 1) }) }
            }
        }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().padding(horizontal = if (expanded) 24.dp else 16.dp)) {
            if (tab != 1 || !state.connected || state.selection == null) Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
                if (!expanded) { StorytellerMark(40.dp); Spacer(Modifier.width(10.dp)) }
                Text(stringResource(R.string.app_name), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                if (state.connected) {
                    IconButton(onClick = onRefresh, enabled = !state.loading) { Icon(Icons.Default.Refresh, "Sync library") }
                    var accountMenu by remember { mutableStateOf(false) }
                    Box { IconButton(onClick = { accountMenu = true }) { Icon(Icons.Default.MoreVert, "Account options") }; DropdownMenu(expanded = accountMenu, onDismissRequest = { accountMenu = false }) { DropdownMenuItem(text = { Text("Disconnect account") }, onClick = { accountMenu = false; onDisconnect() }) } }
                }
            }
            if (state.message.isNotEmpty() && (tab != 1 || state.message != "Your progress is synced.")) Text(state.message, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(bottom = 8.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (state.pending > 0) Text("${state.pending} issue reports waiting to sync", style = MaterialTheme.typography.labelMedium)
            if (!state.connected) {
                Column(Modifier.fillMaxWidth().weight(1f), verticalArrangement = Arrangement.Center) {
                    StorytellerMark(112.dp)
                    Text("Pick up the story", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.padding(top = 24.dp))
                    Text("Connect your account to listen, save your place, and mark anything that needs fixing.", Modifier.padding(vertical = 16.dp))
                    if (state.pairCode.isNotEmpty()) Text(state.pairCode, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(bottom = 16.dp))
                    Button(onClick = onConnect, modifier = Modifier.fillMaxWidth()) { Text("Connect account") }
                }
            } else Box(Modifier.weight(1f)) {
                val play: (Book, String, Chapter) -> Unit = { b, e, c -> onPlay(b, e, c); tab = 1 }
                val mark: () -> Unit = { issueAt = state.position; issueSelection = state.selection?.json()?.toString(); if (state.playing) onToggle() }
                when (tab) {
                    0 -> {
                        if (storyId == null) StoryLibrary(state, { storyId = it }, Modifier.fillMaxSize())
                        else StoryDetail(state, storyId!!, { storyId = null }, play, onFollow, onCheck, onAudio, onJob, Modifier.fillMaxSize())
                    }
                    4 -> Column(Modifier.fillMaxSize()) {
                        Text("Tools", style = MaterialTheme.typography.headlineSmall)
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = { tab = 3; onHistory(false) }) { Text("Location history") }
                            TextButton(onClick = { tab = 2 }) { Text("Marked issues") }
                        }
                        LibraryTools(state, Modifier.weight(1f), onFollow, onCheck, onJob, onIncludeAuthorNotes)
                    }
                    1 -> Column(Modifier.fillMaxSize()) {
                        TextButton(onClick = { storyId = state.selection?.story; tab = 0 }) { Text("Back to story") }
                        PlayerPanel(state, onToggle, onSeek, onSpeed, mark, onFinished, { state.selection?.let { onCharacters(it.story); showCharacters = true } }, Modifier.weight(1f), onPassage, onReturn)
                    }
                    3 -> LazyColumn(verticalArrangement = Arrangement.spacedBy(16.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
                        item { TextButton(onClick = { tab = 4 }) { Text("Back to tools") }; Text("Location history", style = MaterialTheme.typography.headlineSmall); Text("Every saved checkpoint and jump, including where each jump started.") }
                        if (state.history.isEmpty()) item { Text("Your listening locations will appear here after sync.") }
                        items(state.history, key = { it.getString("eventId") }) { event ->
                            val l = event.getJSONObject("location")
                            OutlinedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp)) {
                                Text("${l.getString("chapterTitle")} · ${formatTime(l.getDouble("seconds"))}", style = MaterialTheme.typography.titleMedium)
                                Text("${event.getString("reason")} · Passage ${l.getInt("passageIndex") + 1} · ${editionName(l.getString("edition"))}")
                                Text(java.text.DateFormat.getDateTimeInstance().format(java.util.Date(event.getLong("deviceTime"))), style = MaterialTheme.typography.labelSmall)
                                Text("${formatTime(l.getDouble("storySeconds"))} into ${formatTime(l.getDouble("storyDuration"))} of generated audio")
                                Text(l.optString("excerpt"), fontFamily = FontFamily.Serif, modifier = Modifier.padding(vertical = 8.dp))
                                TextButton(onClick = { onReturn(l); tab = 1 }) { Text("Return here") }
                                event.optJSONObject("from")?.let { from -> Text("From ${from.getString("chapterTitle")} · ${formatTime(from.getDouble("seconds"))}"); TextButton(onClick = { onReturn(from); tab = 1 }) { Text("Before this jump") } }
                            } }
                        }
                        if (state.historyBefore != null) item { TextButton(onClick = { onHistory(true) }) { Text("Load earlier locations") } }
                    }
                    else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        item { TextButton(onClick = { tab = 4 }) { Text("Back to tools") }; Text("Marked issues", style = MaterialTheme.typography.headlineSmall) }
                        if (state.issues.isEmpty()) item { Text("Mark an issue while listening. Its chapter, recording and timestamp are saved together.") }
                        items(state.issues.reversed(), key = { it.getString("id") }) { issue -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp)) {
                            Text("Chapter ${issue.getInt("sequence")} · ${issue.getString("edition")} · ${formatTime(issue.getDouble("seconds"))}", fontWeight = FontWeight.SemiBold)
                            Text(issue.getString("kind")); if (issue.optString("note").isNotEmpty()) Text(issue.getString("note"))
                            TextButton(onClick = { onResolve(issue) }) { Text(if (issue.getString("status") == "open") "Mark resolved" else "Reopen issue") }
                        } } }
                    }
                }
            }
            if (state.connected && tab != 1) state.selection?.let { selected ->
                HorizontalDivider()
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { tab = 1 }, modifier = Modifier.weight(1f)) {
                        Column(Modifier.fillMaxWidth()) { Text(selected.bookTitle, maxLines = 1, overflow = TextOverflow.Ellipsis); Text("${selected.chapter.title} · ${formatTime(state.position)}", style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                    }
                    IconButton(onClick = onToggle) { Icon(if (state.playing) Icons.Default.Pause else Icons.Default.PlayArrow, if (state.playing) "Pause audio" else "Play audio") }
                }
            }
        }
    }
    }
    }
    issueAt?.let { seconds -> IssueDialog(seconds, { issueAt = null }) { kind, note -> issueSelection?.let { onIssue(selectionFromJson(JSONObject(it)), seconds, kind, note) }; issueAt = null } }
    if (showCharacters) AlertDialog(onDismissRequest = { showCharacters = false }, title = { Text("Characters encountered") }, text = {
        LazyColumn { if (state.characters.isEmpty()) item { Text("Characters appear as you reach their first scene.") }; items(state.characters) { c -> Column(Modifier.padding(bottom = 16.dp)) { Text(c.getString("name"), fontWeight = FontWeight.Bold); Text(c.getString("portrayal")) } } }
    }, confirmButton = { TextButton(onClick = { showCharacters = false }) { Text("Close") } })
}

@Composable
fun AuthorNoteSetting(include: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(value = include, role = Role.Checkbox, onValueChange = onChange)
        .padding(horizontal = 8.dp, vertical = 8.dp).testTag("include-author-notes"), verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked = include, onCheckedChange = null)
        Column(Modifier.weight(1f).padding(start = 12.dp)) {
            Text("Include author notes", style = MaterialTheme.typography.bodyLarge)
            Text("Turn off to skip tagged notes during playback. Chapter text and downloads stay available.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

private fun unreadAudio(count: Int): String = "$count unread audio ${if (count == 1) "chapter" else "chapters"}"

private data class ListeningSummary(val edition: String, val latest: JSONObject?, val unread: Int, val remaining: Double)

private fun listeningSummary(book: Book, state: ListenerUiState): ListeningSummary {
    val saved = state.positions.filter { it.optString("story") == book.id }
    val latest = saved.sortedByDescending { it.optLong("deviceTime") }.firstOrNull { p -> book.editions[p.optString("edition")]?.any { it.assembly == p.optString("assembly") } == true }
    val current = state.selection?.takeIf { it.story == book.id && book.editions[it.edition]?.any { c -> c.assembly == it.chapter.assembly } == true }
    val edition = current?.edition ?: latest?.optString("edition") ?: book.defaultEdition
    val chapters = book.editions[edition].orEmpty()
    val unread = chapters.filter { "${book.id}:${it.id}" !in state.completed }
    val remaining = unread.sumOf { chapter ->
        val seconds = if (current?.chapter?.assembly == chapter.assembly) state.position else saved.firstOrNull { it.optString("edition") == edition && it.optString("assembly") == chapter.assembly }?.optDouble("seconds") ?: 0.0
        chapter.duration - seconds.coerceIn(0.0, chapter.duration)
    }
    val location = if (current != null) current.location(state.position) else latest
    return ListeningSummary(edition, location, unread.size, remaining)
}

@Composable
private fun StoryLibrary(state: ListenerUiState, onOpen: (String) -> Unit, modifier: Modifier) {
    var query by rememberSaveable { mutableStateOf("") }
    val matches: (String, String) -> Boolean = { title, author -> query.isBlank() || "$title $author".contains(query.trim(), ignoreCase = true) }
    LazyColumn(modifier.testTag("library"), contentPadding = PaddingValues(bottom = 24.dp)) {
        item { Text("Your stories", style = MaterialTheme.typography.headlineMedium); Text("Choose a story to continue.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp, bottom = 24.dp)) }
        item { OutlinedTextField(value = query, onValueChange = { query = it }, label = { Text("Find a book") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(bottom = 16.dp)) }
        if (state.books.isEmpty() && state.catalog.isEmpty()) item { Text(if (state.loading) "Loading your library…" else "Published audiobooks appear here after sync. Follow a story in Tools to prepare local audio.") }
        val books = state.books.filter { matches(it.title, it.author) }
        val sources = state.catalog.filter { source -> state.books.none { it.id == source.getString("id") } && matches(source.getString("title"), source.optString("author")) }
        if (query.isNotBlank() && books.isEmpty() && sources.isEmpty()) item { Text("No matching books. Try another title or author.") }
        items(books, key = { it.id }) { book ->
            val summary = listeningSummary(book, state)
            val latestChapter = summary.latest?.let { p -> book.editions[p.optString("edition")]?.find { it.assembly == p.optString("assembly") } }
            StoryRow(book.id, book.title, book.author,
                latestChapter?.let { "Your place: Chapter ${it.sequence} · ${formatTime(summary.latest!!.optDouble("seconds"))}" } ?: "Not started",
                "${unreadAudio(summary.unread)} · ${formatTime(summary.remaining)} remaining", { onOpen(book.id) }, state.catalog.find { it.optString("id") == book.id }?.optJSONObject("repair")?.optString("title"))
        }
        items(sources, key = { "source:${it.getString("id")}" }) { source ->
            val job = source.optJSONObject("job")
            val active = source.optJSONObject("follow")?.let { it.optBoolean("enabled") && it.optString("mode") != "download" } == true
            StoryRow(source.getString("id"), source.getString("title"), source.optString("author"),
                if (!source.optBoolean("supported", true)) "Unsupported file" else if (active) job?.optString("phase")?.takeIf { it.isNotBlank() } ?: "Waiting to prepare audio" else "Audiobook off",
                "${source.getJSONArray("chapters").length()} source chapters", { onOpen(source.getString("id")) }, source.optJSONObject("repair")?.optString("title"))
        }
    }
}

@Composable
private fun StoryRow(id: String, title: String, author: String, position: String, unread: String, onOpen: () -> Unit, repair: String? = null) {
    Surface(onClick = onOpen, modifier = Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.background) {
        Row(Modifier.padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            StoryCover(id, Modifier.size(width = 48.dp, height = 72.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(title, style = MaterialTheme.typography.titleLarge)
                if (author.isNotBlank()) Text(author, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(position, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(unread, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
                if (!repair.isNullOrBlank()) Text(repair, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            }
            Icon(Icons.Default.ChevronRight, null)
        }
    }
    HorizontalDivider()
}

@Composable
private fun StoryDetail(state: ListenerUiState, id: String, onBack: () -> Unit, onPlay: (Book, String, Chapter) -> Unit, onFollow: (String, Boolean, String) -> Unit, onCheck: (String) -> Unit, onAudio: (String, Boolean) -> Unit, onJob: (String, String) -> Unit, modifier: Modifier) {
    val book = state.books.find { it.id == id }
    val source = state.catalog.find { it.getString("id") == id }
    val summary = book?.let { listeningSummary(it, state) }
    var edition by rememberSaveable(id) { mutableStateOf(summary?.edition.orEmpty()) }
    LaunchedEffect(book?.editions?.keys) { if (book != null && edition !in book.editions) edition = book.defaultEdition }
    Column(modifier) {
        TextButton(onClick = onBack) { Text("Back to library") }
        LazyColumn(Modifier.weight(1f).testTag("story-chapters"), verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
            item {
                Text(book?.title ?: source?.optString("title") ?: "Story unavailable", style = MaterialTheme.typography.headlineMedium)
                Text(book?.author ?: source?.optString("author").orEmpty(), color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (book != null && summary != null) {
                    Text("${unreadAudio(summary.unread)} · ${formatTime(summary.remaining)} remaining", Modifier.padding(vertical = 12.dp))
                    val latest = summary.latest
                    val resume = latest?.let { p -> book.editions[p.optString("edition")]?.find { it.assembly == p.optString("assembly") } }
                    val first = book.editions[summary.edition]?.firstOrNull()
                    if (resume != null) Button(onClick = { onPlay(book, latest!!.optString("edition"), resume) }) { Text("Continue listening") }
                    else if (first != null) Button(onClick = { onPlay(book, summary.edition, first) }) { Text("Start listening") }
                } else Text("Turn on audiobook generation below to prepare chapters for listening.", Modifier.padding(vertical = 16.dp))
            }
            // Keep edition controls in their own lazy item so they remain reachable with large text.
            if (book != null) item {
                Column(Modifier.fillMaxWidth().testTag("edition-picker")) {
                Text("Chapters", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(top = 12.dp, bottom = 8.dp))
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    book.editions.keys.forEach { value -> FilterChip(selected = edition == value, onClick = { edition = value }, label = { Text(editionName(value)) }) }
                }
                }
            }
            source?.optJSONObject("repair")?.let { repair -> item { RepairStatusPanel(repair) } }
            item { BookAudioControls(id, source, book, edition, state.updatingStories.contains(id), state.storyErrors[id], onAudio, onJob) }
            if (book != null) items(book.editions[edition].orEmpty(), key = { "$edition:${it.id}" }) { chapter ->
                OutlinedCard(onClick = { onPlay(book, edition, chapter) }, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) {
                        Text(chapter.title, style = MaterialTheme.typography.titleMedium)
                        if (edition == "qwen") repairChapterLabel(source?.optJSONObject("repair"), chapter.id)?.let { Text(it, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium) }
                        Text("${formatTime(chapter.duration)}${if ("${book.id}:${chapter.id}" in state.completed) " · Finished" else ""}", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            if (source != null) item {
                var preparation by rememberSaveable(id) { mutableStateOf(false) }
                TextButton(onClick = { preparation = !preparation }) { Text(if (preparation) "Hide story preparation" else "Story preparation") }
                if (preparation) StoryPreparation(source, onFollow, onCheck)
            }
        }
    }
}

@Composable
private fun LibraryTools(state: ListenerUiState, modifier: Modifier, onFollow: (String, Boolean, String) -> Unit, onCheck: (String) -> Unit, onJob: (String, String) -> Unit, onIncludeAuthorNotes: (Boolean) -> Unit) {
    var adding by rememberSaveable { mutableStateOf(false) }
    if (adding) FollowDialog({ adding = false }) { url, mode -> onFollow(url, true, mode); adding = false }
    LazyColumn(modifier.testTag("tools"), verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
        item { OutlinedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(8.dp)) { Text("Playback", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 8.dp, vertical = 8.dp)); AuthorNoteSetting(state.includeAuthorNotes, onIncludeAuthorNotes) } } }
        item { OfflineDownloadsPanel(state.books) }
        item { Text("Source library", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(top = 24.dp)); Text("Follow stories to download new chapters and prepare Qwen audio."); OutlinedButton(onClick = { adding = true }) { Text("Follow a story") } }
        items(state.jobs.filter { it.optString("status") !in listOf("complete", "cancelled") }.take(12), key = { "job:${it.getString("id")}" }) { job ->
            OutlinedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp)) {
                Text(job.getString("phase"), fontWeight = FontWeight.SemiBold)
                if (job.optString("error").isNotBlank()) Text(job.getString("error"))
                if (job.getString("status") in listOf("queued", "running", "waiting")) TextButton(onClick = { onJob(job.getString("id"), "cancel") }) { Text(if (job.optBoolean("cancel")) "Cancelling after this passage…" else "Cancel job") }
                if (job.getString("status") in listOf("failed", "waiting")) TextButton(onClick = { onJob(job.getString("id"), "retry") }) { Text("Retry now") }
            } }
        }
    }
}

@Composable
private fun StoryPreparation(story: JSONObject, onFollow: (String, Boolean, String) -> Unit, onCheck: (String) -> Unit) {
    val uri = LocalUriHandler.current
            val follow = story.optJSONObject("follow")
            val chapters = story.getJSONArray("chapters")
            var expanded by rememberSaveable(story.getString("id")) { mutableStateOf(false) }
            var modeMenu by remember { mutableStateOf(false) }
            var mode by rememberSaveable(story.getString("id"), follow?.optString("mode")) { mutableStateOf(follow?.optString("mode") ?: "buffer") }
            OutlinedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (story.optBoolean("hasCover")) StoryCover(story.getString("id"), Modifier.size(width = 60.dp, height = 88.dp))
                    Column(Modifier.weight(1f)) { Text(story.getString("title"), style = MaterialTheme.typography.titleLarge, fontFamily = FontFamily.Serif); Text(story.optString("author"), style = MaterialTheme.typography.bodySmall) }
                }
                Text("${chapters.length()} chapters · ${story.optString("status").lowercase()}")
                Text(story.optString("description"), maxLines = if (expanded) Int.MAX_VALUE else 3)
                TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Show less" else "Story details") }
                TextButton(onClick = { uri.openUri(story.getString("url")) }) { Text(if (story.getString("id").startsWith("bo-")) "Open in BookOrbit" else "Open on Royal Road") }
                if (story.optBoolean("supported", true)) Column {
                Box {
                    TextButton(onClick = { modeMenu = true }) { Text(when (mode) { "all" -> "Audio: every chapter"; "download" -> "Download text only"; else -> "Audio: next 5 unread chapters" }) }
                    DropdownMenu(expanded = modeMenu, onDismissRequest = { modeMenu = false }) {
                        listOf("buffer" to "Next 5 unread chapters", "all" to "Every available chapter", "download" to "Download text only").forEach { (value, label) ->
                            DropdownMenuItem(text = { Text(label) }, onClick = { mode = value; modeMenu = false; onFollow(story.getString("url"), follow?.optBoolean("enabled") ?: false, mode) })
                        }
                    }
                }
                Button(onClick = { onFollow(story.getString("url"), follow?.optBoolean("enabled") != true, mode) }) { Text(if (follow?.optBoolean("enabled") == true) "Pause automatic checks" else "Follow story") }
                if (follow != null) TextButton(onClick = { onCheck(story.getString("id")) }) { Text("Check now") }
                }
                if (expanded) for (i in 0 until chapters.length()) {
                    val chapter = chapters.getJSONObject(i); val editions = chapter.getJSONArray("editions")
                    Text(chapter.getString("title"), fontWeight = FontWeight.SemiBold)
                    Text(if (editions.length() > 0) "Audio: " + (0 until editions.length()).joinToString { editionName(editions.getString(it)) } else if (chapter.optBoolean("downloaded")) "Text downloaded · audio not generated" else "Not downloaded", style = MaterialTheme.typography.bodySmall)
                }
            } }

}

@Composable
private fun PlayerPanel(state: ListenerUiState, onToggle: () -> Unit, onSeek: (Double) -> Unit, onSpeed: (Float) -> Unit,
    onIssue: () -> Unit, onFinished: () -> Unit, onCharacters: () -> Unit, modifier: Modifier, onPassage: (Double) -> Unit, onReturn: (JSONObject) -> Unit) {
    val selected = state.selection
    var dragging by remember { mutableStateOf<Float?>(null) }
    var speedMenu by remember { mutableStateOf(false) }
    var more by remember { mutableStateOf(false) }
    if (selected == null) {
        Column(modifier, verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            StorytellerMark(112.dp)
            Text("A story is waiting", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(top = 20.dp))
            Text("Choose a chapter from your library.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    Column(modifier.testTag("player-scroll")) {
        Row(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(selected.bookTitle, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(selected.chapter.title, fontSize = 17.sp, lineHeight = 22.sp, fontFamily = FontFamily.Serif, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Box {
                IconButton(onClick = { more = true }) { Icon(Icons.Default.MoreHoriz, "Chapter options") }
                DropdownMenu(expanded = more, onDismissRequest = { more = false }) {
                    DropdownMenuItem(text = { Text("Characters encountered") }, onClick = { more = false; onCharacters() })
                    DropdownMenuItem(text = { Text("Mark chapter finished") }, onClick = { more = false; onFinished() })
                }
            }
        }
        ReadingPanel(state, onPassage, Modifier.weight(1f))
        Surface(color = MaterialTheme.colorScheme.surface) {
            Column(Modifier.padding(top = 4.dp, bottom = 2.dp)) {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Slider(value = dragging ?: state.position.toFloat().coerceIn(0f, selected.chapter.duration.toFloat().coerceAtLeast(1f)), onValueChange = { dragging = it },
                    onValueChangeFinished = { dragging?.let { onSeek(it.toDouble()) }; dragging = null }, valueRange = 0f..selected.chapter.duration.toFloat().coerceAtLeast(1f), modifier = Modifier.height(24.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(formatTime((dragging ?: state.position.toFloat()).toDouble()), style = MaterialTheme.typography.labelSmall)
                    Text("−${formatTime((selected.chapter.duration - (dragging ?: state.position.toFloat())).coerceAtLeast(0.0))}", style = MaterialTheme.typography.labelSmall)
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
                    Box {
                        TextButton(onClick = { speedMenu = true }, contentPadding = PaddingValues(4.dp)) { Text("${state.speed}×") }
                        DropdownMenu(expanded = speedMenu, onDismissRequest = { speedMenu = false }) { listOf(0.8f, 1f, 1.2f, 1.5f, 2f).forEach { speed -> DropdownMenuItem(text = { Text("${speed}×") }, onClick = { onSpeed(speed); speedMenu = false }) } }
                    }
                    IconButton(onClick = { onSeek((state.position - 15).coerceAtLeast(0.0)) }) { Icon(Icons.Default.Replay, "Back 15 seconds") }
                    FilledIconButton(onClick = onToggle, Modifier.size(48.dp)) { Icon(if (state.playing) Icons.Default.Pause else Icons.Default.PlayArrow, if (state.playing) "Pause" else "Play", Modifier.size(32.dp)) }
                    IconButton(onClick = { onSeek((state.position + 30).coerceAtMost(selected.chapter.duration)) }) { Icon(Icons.Default.Forward30, "Forward 30 seconds") }
                    IconButton(onClick = onIssue) { Icon(Icons.Default.Flag, "Mark issue at ${formatTime(state.position)}") }
                }
                if (state.undo != null) TextButton(onClick = { onReturn(state.undo) }, Modifier.fillMaxWidth()) { Icon(Icons.AutoMirrored.Filled.Undo, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Undo jump") }
            }
        }
    }
}
@Composable
private fun IssueDialog(seconds: Double, dismiss: () -> Unit, save: (String, String) -> Unit) {
    var kind by rememberSaveable { mutableStateOf("delivery") }; var note by rememberSaveable { mutableStateOf("") }
    AlertDialog(onDismissRequest = dismiss, title = { Text("Issue at ${formatTime(seconds)}") }, text = { Column(Modifier.imePadding().verticalScroll(rememberScrollState())) {
        listOf("voice" to "Wrong voice", "pronunciation" to "Pronunciation", "missing" to "Missing or repeated text", "delivery" to "Delivery or pacing", "other" to "Other").forEach { (id, title) ->
            TextButton(onClick = { kind = id }, modifier = Modifier.fillMaxWidth()) { RadioButton(selected = kind == id, onClick = null); Text(title, Modifier.weight(1f).padding(start = 8.dp)) }
        }
        OutlinedTextField(value = note, onValueChange = { note = it.take(2000) }, label = { Text("Optional note") }, modifier = Modifier.fillMaxWidth(), maxLines = 3)
    } }, confirmButton = { TextButton(onClick = { save(kind, note) }) { Text("Save issue") } }, dismissButton = { TextButton(onClick = dismiss) { Text("Cancel") } })
}


@Composable
private fun ReadingPanel(state: ListenerUiState, onPassage: (Double) -> Unit, modifier: Modifier) {
    val reading = state.reading
    val paragraphs = remember(reading) { reading?.let(::bookParagraphs).orEmpty() }
    val scroll = rememberLazyListState()
    var follow by rememberSaveable(state.selection?.chapter?.assembly) { mutableStateOf(true) }
    var size by rememberSaveable { mutableIntStateOf(14) }
    val dragged by scroll.interactionSource.collectIsDraggedAsState()
    val active = reading?.passages?.lastOrNull { it.start <= state.position } ?: reading?.passages?.firstOrNull()
    LaunchedEffect(dragged) { if (dragged) follow = false }
    LaunchedEffect(active?.id, follow, reading?.assembly) {
        val target = paragraphs.indexOfFirst { paragraph -> paragraph.fragments.any { it.passage.id == active?.id } }
        if (follow && target >= 0) {
            val visible = scroll.layoutInfo.visibleItemsInfo
            if (visible.none { it.index == target && it.offset >= 0 && it.offset + it.size <= scroll.layoutInfo.viewportEndOffset }) {
                scroll.animateScrollToItem(target)
            }
        }
    }
    Column(modifier) {
        Row(Modifier.fillMaxWidth().height(40.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { follow = !follow }, contentPadding = PaddingValues(horizontal = 0.dp)) {
                Text(if (follow) "Following audio" else "Follow audio", fontSize = 12.sp)
            }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = { size = if (size >= 20) 12 else size + 2 }, contentPadding = PaddingValues(horizontal = 0.dp)) { Text("Text · $size", fontSize = 12.sp) }
        }
        if (reading == null) Text("Chapter text is loading.", style = MaterialTheme.typography.bodySmall)
        else LazyColumn(Modifier.fillMaxWidth().weight(1f).testTag("passages"), state = scroll, contentPadding = PaddingValues(top = 4.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(paragraphs) { paragraph ->
                var layout by remember(paragraph) { mutableStateOf<TextLayoutResult?>(null) }
                val highlight = MaterialTheme.colorScheme.primary.copy(alpha = 0.07f)
                val text = buildAnnotatedString {
                    append(paragraph.text)
                    paragraph.fragments.filter { it.passage.id == active?.id }.forEach { addStyle(SpanStyle(background = highlight), it.start, it.end) }
                }
                Text(text, fontFamily = FontFamily.Serif, fontSize = size.sp, letterSpacing = 0.sp, lineHeight = (size * 1.43).sp,
                    onTextLayout = { layout = it },
                    modifier = Modifier.fillMaxWidth().pointerInput(paragraph) {
                        detectTapGestures { point ->
                            layout?.getOffsetForPosition(point)?.let { offset ->
                                paragraph.fragments.firstOrNull { offset >= it.start && offset < it.end }?.let { onPassage(it.passage.start) }
                            }
                        }
                    }.semantics {
                        onClick(label = "Listen from this paragraph") { paragraph.fragments.firstOrNull()?.let { onPassage(it.passage.start) }; true }
                        customActions = paragraph.fragments.distinctBy { it.passage.id }.map { fragment ->
                            CustomAccessibilityAction("Listen from ${formatTime(fragment.passage.start)}") { onPassage(fragment.passage.start); true }
                        }
                    })
            }
        }
    }
}


@Composable
private fun FollowDialog(dismiss: () -> Unit, save: (String, String) -> Unit) {
    var url by rememberSaveable { mutableStateOf("") }
    var mode by rememberSaveable { mutableStateOf("buffer") }
    AlertDialog(onDismissRequest = dismiss, title = { Text("Follow a Royal Road story") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            OutlinedTextField(value = url, onValueChange = { url = it.take(1000) }, label = { Text("Royal Road story URL") }, modifier = Modifier.fillMaxWidth(), maxLines = 3)
            listOf("buffer" to "Next 5 unread chapters", "all" to "Every available chapter", "download" to "Download text only").forEach { (value, label) ->
                TextButton(onClick = { mode = value }) { RadioButton(selected = mode == value, onClick = null); Text(label) }
            }
            Text("Checks every 6 hours. New audio uses Qwen and the saved story cast.")
        }
    }, confirmButton = { TextButton(onClick = { save(url.trim(), mode) }, enabled = url.isNotBlank()) { Text("Follow story") } }, dismissButton = { TextButton(onClick = dismiss) { Text("Cancel") } })
}

@Composable
private fun StoryCover(story: String, modifier: Modifier) {
    val context = LocalContext.current
    val cover by produceState<ImageBitmap?>(null, story) {
        value = runCatching { withContext(Dispatchers.IO) {
            val bytes = ListenerApi(context).cover(story)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
        } }.getOrNull()
    }
    Box(modifier.clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
        if (cover != null) Image(cover!!, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        else Icon(Icons.AutoMirrored.Filled.LibraryBooks, null, tint = MaterialTheme.colorScheme.onPrimaryContainer)
    }
}

/** Decorative beside the visible app name or connection heading. */
@Composable
private fun StorytellerMark(size: Dp) {
    Box(Modifier.size(size).background(colorResource(R.color.ic_launcher_background), RoundedCornerShape(size / 4)).padding(size / 12)) {
        Image(painterResource(R.drawable.storyteller_mark), null, Modifier.fillMaxSize())
    }
}
