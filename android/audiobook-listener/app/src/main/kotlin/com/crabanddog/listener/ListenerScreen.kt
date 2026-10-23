package com.crabanddog.listener

import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.LibraryBooks
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

internal fun jsonObjects(array: org.json.JSONArray?): List<JSONObject> = (0 until (array?.length() ?: 0)).map { array!!.getJSONObject(it) }
internal data class ListeningSummary(val edition: String, val latest: JSONObject?, val unread: Int, val remaining: Double)
internal fun listeningSummary(book: Book, state: ListenerUiState): ListeningSummary {
    val saved = state.positions.filter { it.optString("story") == book.id }
    val latest = currentContinuationPositions(saved).firstOrNull { p -> book.editions[p.optString("edition")]?.any { it.assembly == p.optString("assembly") } == true }
    val current = state.selection?.takeIf { it.story == book.id && it.continuationRevision >= (latest?.optLong("continuationRevision") ?: 0) }
    val edition = current?.edition ?: latest?.optString("edition") ?: book.defaultEdition.takeIf { book.editions[it]?.isNotEmpty() == true } ?: book.editions.keys.firstOrNull().orEmpty()
    val unread = book.editions[edition].orEmpty().filter { "${book.id}:${it.id}" !in state.completed }
    val remaining = unread.sumOf { chapter ->
        val seconds = if (current?.chapter?.assembly == chapter.assembly) state.position else saved.firstOrNull { it.optString("edition") == edition && it.optString("assembly") == chapter.assembly }?.optDouble("seconds") ?: 0.0
        val view = chapterView(chapter, state.reading, state.includeAuthorNotes)
        (view.duration - view.position(seconds)).coerceAtLeast(0.0)
    }
    return ListeningSummary(edition, current?.location(state.position) ?: latest, unread.size, remaining)
}

internal fun listeningPlace(book: Book, state: ListenerUiState, point: JSONObject?): String {
    val chapter = point?.let { book.editions[it.optString("edition")]?.find { chapter -> chapter.assembly == it.optString("assembly") } } ?: return "Not started"
    return "Chapter ${chapter.sequence} · ${formatTime(chapterView(chapter, state.reading, state.includeAuthorNotes).position(point.optDouble("seconds")))}"
}

@Suppress("UNUSED_PARAMETER")
@Composable
fun ListenerScreen(state: ListenerUiState, onConnect: () -> Unit, onRefresh: () -> Unit,
    onDisconnect: () -> Unit = {}, onPlay: (Book, String, Chapter) -> Unit, onToggle: () -> Unit, onSeek: (Double) -> Unit,
    onSpeed: (Float) -> Unit, onIssue: (Selection, Double, String, String) -> Unit, onFinished: () -> Unit,
    onResolve: (JSONObject) -> Unit, onCharacters: (String) -> Unit, onPassage: (Double) -> Unit = onSeek,
    onHistory: (Boolean) -> Unit = {}, onReturn: (JSONObject) -> Unit = {},
    onFollow: (String, Boolean, String) -> Unit = { _, _, _ -> }, onCheck: (String) -> Unit = {}, onJob: (String, String) -> Unit = { _, _ -> }, onAudio: (String, Boolean) -> Unit = { _, _ -> }, onIncludeAuthorNotes: (Boolean) -> Unit = {}, onSkip: ((Int) -> Unit)? = null,
    onEdition: (String) -> Unit = {}, onCancelSignIn: () -> Unit = {}, onCancelReturn: () -> Unit = {}, onPassageSelection: ((Selection, Double) -> Unit)? = null, onSaveIssue: ((Selection, Double, String, String) -> Boolean)? = null, onChapterPlay: ((Book, String, Chapter) -> Unit)? = null) {
    val context = LocalContext.current
    val wide = androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp >= 700
    val store = remember(context) { ListenerStore.get(context) }
    val offline = remember(context) { OfflineAudio(context) }
    val scope = rememberCoroutineScope()
    var clearing by remember { mutableStateOf(false) }
    var clearError by remember { mutableStateOf("") }
    val uri = LocalUriHandler.current
    var screen by rememberSaveable { mutableStateOf("library") }
    var storyId by rememberSaveable { mutableStateOf<String?>(null) }
    var stack by rememberSaveable { mutableStateOf("[]") }
    var browseJson by rememberSaveable { mutableStateOf<String?>(null) }
    val browsingCanPlay = browseJson?.let { JSONObject(it).optBoolean("playable", true) } ?: true
    val browsing = browseJson?.let { runCatching { selectionFromJson(JSONObject(it)) }.getOrNull() }
    var sheet by rememberSaveable { mutableStateOf<String?>(null) }
    var menuStory by rememberSaveable { mutableStateOf<String?>(null) }
    var clearStory by rememberSaveable { mutableStateOf<String?>(null) }
    var issueDraft by remember { mutableStateOf<JSONObject?>(null) }
    var draftError by remember { mutableStateOf("") }
    var textSize by remember { mutableFloatStateOf(store.textSize()) }
    val holder = rememberSaveableStateHolder()
    val selectedBook = state.books.find { it.id == storyId }
    val source = state.catalog.find { it.optString("id") == storyId }
    fun navigate(target: String, id: String? = storyId) {
        if (screen == target && storyId == id) return
        val entries = org.json.JSONArray(stack).put(JSONObject().put("screen", screen).put("story", storyId))
        stack = entries.toString(); storyId = id; screen = target
    }
    fun openBook(id: String) { navigate("book", id) }
    fun openReader() { navigate("listening") }
    fun back() {
        if (sheet != null) { if (sheet == "history") onCancelReturn(); sheet = null; return }
        val entries = org.json.JSONArray(stack)
        if (entries.length() > 0) {
            val parent = entries.getJSONObject(entries.length() - 1); entries.remove(entries.length() - 1)
            stack = entries.toString(); screen = parent.getString("screen"); storyId = if (parent.isNull("story")) null else parent.getString("story")
        } else { screen = "library"; storyId = null }
    }
    BackHandler(enabled = state.connected && screen != "library") { back() }
    BackHandler(enabled = !state.connected && (state.signingIn || state.signInUrl.isNotEmpty())) { onCancelSignIn() }
    LaunchedEffect(state.connected) { if (!state.connected) { screen = "library"; storyId = null; sheet = null; browseJson = null; stack = "[]"; menuStory = null; clearStory = null; issueDraft = null } }
    val playBook: (Book) -> Unit = { book ->
        val summary = listeningSummary(book, state)
        val chapter = book.editions[summary.edition]?.find { it.assembly == summary.latest?.optString("assembly") } ?: book.editions[summary.edition]?.firstOrNull()
        if (chapter != null) { browseJson = null; onPlay(book, summary.edition, chapter); openReader() }
    }
    val mark: () -> Unit = {
        state.selection?.let { selection ->
            if (state.playing) onToggle()
            issueDraft = store.draft(selection.story) ?: describeLocalLocation(selection, state.reading, state.position)
                .put("eventId", java.util.UUID.randomUUID().toString()).put("kind", "delivery").put("note", "")
            draftError = if (runCatching { store.draft(selection.story, issueDraft) }.isSuccess) "" else "Couldn’t keep the draft on this phone. Your text stays open. Try saving again."
        }
    }
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).safeDrawingPadding(), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = 860.dp).fillMaxSize()) {
            Row(Modifier.fillMaxWidth().heightIn(min = if (screen == "listening" && state.connected) 80.dp else 64.dp).padding(horizontal = if (wide && screen != "listening") 32.dp else 8.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if ((state.connected && screen != "library") || (!state.connected && (state.signingIn || state.signInUrl.isNotEmpty()))) IconButton(onClick = { if (state.connected) back() else onCancelSignIn() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", modifier = Modifier.size(22.dp)) }
                StorytellerMark(if (screen == "listening") 30.dp else 32.dp)
                if (screen == "listening" && state.connected) {
                    val audio = state.selection ?: browsing
                    val count = state.books.find { it.id == audio?.story }?.editions?.values?.flatten()?.distinctBy { it.id }?.size ?: 0
                    Column(Modifier.weight(1f).clickable(role = Role.Button) { navigate("chapters", audio?.story) }.semantics { contentDescription = "Chapters" }.padding(horizontal = 2.dp)) {
                        Text(audio?.bookTitle.orEmpty(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(if (count > 0) "Chapter ${audio?.chapter?.sequence} of $count" else "Chapter ${audio?.chapter?.sequence ?: 1}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 3.dp, bottom = 3.dp))
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) { Text(audio?.chapter?.title ?: "Listening", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f, fill = false)); Icon(Icons.Default.ExpandMore, null, modifier = Modifier.size(16.dp)) }
                    }
                } else Text(if (!state.connected) "Listener" else when (screen) { "library" -> "Your library"; "chapters" -> "Chapters"; "downloads" -> "Downloads"; "preparation" -> "Preparation"; "issues" -> "Marked issues"; "account" -> "Account"; else -> "Book" }, modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontSize = 17.6.sp, fontWeight = FontWeight.SemiBold)
                if (state.connected) {
                    when (screen) {
                        "listening" -> IconButton(onClick = { sheet = "settings" }) { Icon(Icons.Default.Settings, "Listening settings", modifier = Modifier.size(20.dp)) }
                        "downloads" -> IconButton(onClick = { sheet = "download-settings" }) { Icon(Icons.Default.Settings, "Download settings", modifier = Modifier.size(20.dp)) }
                        "preparation" -> IconButton(onClick = { sheet = "preparation-settings" }) { Icon(Icons.Default.Settings, "Preparation settings", modifier = Modifier.size(20.dp)) }
                        "account" -> Unit
                        "library", "book", "chapters", "issues" -> IconButton(onClick = onRefresh, enabled = !state.loading) { Icon(Icons.Default.Refresh, "Sync library", modifier = Modifier.size(20.dp)) }
                    }
                    if (screen != "listening" && screen != "account") IconButton(onClick = { navigate("account", null) }) { Icon(Icons.Default.MoreVert, "Account", modifier = Modifier.size(20.dp)) }
                }
            }
            HorizontalDivider()
            if (state.connected && screen !in listOf("library", "issues", "preparation", "account") && state.message.isNotEmpty() && state.message != "Your progress is synced." && !state.message.startsWith("Issue saved at")) Text(state.message, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
            if (!state.connected) {
                Column(Modifier.weight(1f).widthIn(max = 500.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 38.dp, vertical = if (state.signInUrl.isNotEmpty() || state.message.startsWith("Sign in timed out")) 40.dp else 26.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    val waiting = state.signInUrl.isNotEmpty()
                    val expired = state.message.startsWith("Sign in timed out")
                    if (!waiting && !expired) { Spacer(Modifier.height(20.dp)); StorytellerMark(86.dp); Spacer(Modifier.height(3.dp)) }
                    Text(if (waiting) "Sign in through your browser" else if (expired) "Sign in timed out" else "Pick up the story", fontSize = 22.4.sp, lineHeight = 29.1.sp, fontWeight = FontWeight.SemiBold)
                    Text(if (waiting) "Return here after signing in. Your library will open automatically." else if (expired) "Try signing in again." else "Sign in to open your library and keep your place across devices.", fontSize = 13.76.sp, lineHeight = 22.sp)
                    if (waiting) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Button(onClick = { uri.openUri(state.signInUrl) }, enabled = !state.offline && !state.signingIn, shape = RoundedCornerShape(8.dp), modifier = Modifier.heightIn(min = 48.dp), contentPadding = PaddingValues(horizontal = 14.dp)) { Text(if (state.signingIn) "Signing in…" else "Continue sign in", fontWeight = FontWeight.Normal) }
                            TextButton(onClick = onCancelSignIn, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)) { Text("Cancel", fontWeight = FontWeight.Normal) }
                        }
                    } else Button(onClick = onConnect, enabled = !state.signingIn && !state.offline, shape = RoundedCornerShape(8.dp), modifier = Modifier.heightIn(min = 48.dp), contentPadding = PaddingValues(horizontal = 14.dp)) { Text(if (state.signingIn) "Opening sign in…" else if (expired) "Start again" else "Sign in", fontWeight = FontWeight.Normal) }
                    if (state.offline) Text("Connect to the internet to continue.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (state.message.isNotEmpty() && state.message != "Finish signing in through your browser." && !expired) Text(state.message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                }
            } else {
                holder.SaveableStateProvider(screen + ":" + storyId) {
                    Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = if (wide && screen in listOf("preparation", "issues", "account")) Alignment.TopCenter else Alignment.TopStart) {
                        when (screen) {
                            "library" -> LibraryPage(state, ::openBook, playBook, { menuStory = it }, onRefresh)
                            "book" -> BookPage(selectedBook, source, state, playBook, { navigate(it) })
                            "chapters" -> ChaptersPage(selectedBook, state, { selection, playable -> browseJson = selection.json().put("playable", playable).toString(); openReader() }, { book, edition, chapter -> browseJson = null; val current = state.selection?.chapter?.assembly == chapter.assembly; val saved = listeningSummary(book, state).latest?.optString("assembly") == chapter.assembly; (if (saved && !current) onPlay else onChapterPlay ?: onPlay)(book, edition, chapter); openReader() })
                            "listening" -> ListeningPage(state, browsing, browsingCanPlay, textSize, { if (state.selection == null && browsing != null) { state.books.find { it.id == browsing.story }?.let { onPlay(it, browsing.edition, browsing.chapter); browseJson = null } } else onToggle() }, onSeek, onPassage, onPassageSelection, onSkip, mark, { sheet = "speed" }, { sheet = "history"; onHistory(false) }, { navigate("chapters", state.selection?.story ?: browsing?.story) }, { browseJson = null }, onReturn, { selected, playable -> browseJson = selected.json().put("playable", playable).toString() }, onRefresh)
                            "downloads" -> selectedBook?.let { DownloadsPage(it, offline, { clearStory = it.id }) }
                            "preparation" -> PreparationPage(selectedBook, source, state, onCheck, onJob, onRefresh)
                            "issues" -> IssuesPage(state, storyId, onResolve)
                            "account" -> AccountPage(state, store, onDisconnect, onRefresh, { draft -> if (state.playing) onToggle(); issueDraft = draft }, { if (state.playing) onToggle() })
                        }
                    }
                }
                if (screen != "listening") state.selection?.let { selection ->
                    HorizontalDivider()
                    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        TextButton(onClick = { browseJson = null; openReader() }, modifier = Modifier.weight(1f).testTag("open-player"), contentPadding = PaddingValues(horizontal = 4.dp)) { Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) { StoryCover(selection.story, Modifier.size(28.dp, 42.dp)); Column(Modifier.weight(1f)) { Text(selection.bookTitle, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurface); Text("Chapter ${selection.chapter.sequence} · ${formatTime(chapterView(selection.chapter, state.reading, state.includeAuthorNotes).position(state.position))}", maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } } }
                        IconButton(onClick = onToggle) { Icon(if (state.playing) Icons.Default.Pause else Icons.Default.PlayArrow, if (state.playing) "Pause" else "Play") }
                    }
                }
            }
        }
    }
    when (sheet) {
        "settings" -> ListeningSettings(state, textSize, { textSize = it; store.textSize(it) }, onEdition, onIncludeAuthorNotes, { sheet = null })
        "speed" -> SpeedSettings(state.speed, onSpeed, { sheet = null })
        "history" -> RecentJumps(state, { onCancelReturn(); sheet = null }, onReturn, { onHistory(true) })
        "download-settings" -> selectedBook?.let { DownloadSettings(it, offline, { sheet = null }) }
        "preparation-settings" -> source?.let { PreparationSettings(it, state, onFollow, { sheet = null }) }
    }
    menuStory?.let { id ->
        val book = state.books.find { it.id == id }
        val downloadedBytes by produceState<Long?>(null, id) { value = withContext(Dispatchers.IO) { book?.let(offline::bookBytes) ?: 0L } }
        ListenerSheet(book?.title ?: "Book", { menuStory = null }) {
            Text(downloadedBytes?.let { "${formatBytes(it)} downloaded on this phone" } ?: "Calculating downloaded size…", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(bottom = 12.dp))
            TextButton(onClick = { menuStory = null; navigate("downloads", id) }, enabled = book != null, modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(horizontal = 4.dp)) { Text("Downloads", modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium) }
            TextButton(onClick = { menuStory = null; clearStory = id }, enabled = book != null && offline.hasBookDownloads(book), modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(horizontal = 4.dp)) { Text("Clear downloads", modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium) }
        }
    }
    clearStory?.let { id -> state.books.find { it.id == id }?.let { book ->
        val downloadedBytes by produceState<Long?>(null, id) { value = withContext(Dispatchers.IO) { offline.bookBytes(book) } }
        ListenerSheet("Clear downloads?", { if (!clearing) clearStory = null }, showClose = false) {
            Text("Remove ${downloadedBytes?.let(::formatBytes) ?: "downloaded audio"} for “${book.title}” from this phone? This clears all downloaded editions of this book. Other books are kept.", style = MaterialTheme.typography.bodyMedium)
            Text("Downloads for this book will pause. Your listening place is kept.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 12.dp))
            if (clearError.isNotEmpty()) Text(clearError, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            FlowRow(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                TextButton(onClick = { clearStory = null }, enabled = !clearing) { Text("Keep downloads", fontWeight = FontWeight.Normal) }
                TextButton(onClick = { val books = state.books; clearing = true; clearError = ""; scope.launch { try { withContext(Dispatchers.IO) { offline.clearBook(book, books) }; clearStory = null } catch (e: Exception) { clearError = "Couldn’t clear all downloads. Try again." } finally { clearing = false } } }, enabled = !clearing, shape = RoundedCornerShape(8.dp), modifier = Modifier.heightIn(min = 48.dp), contentPadding = PaddingValues(horizontal = 12.dp)) { Text(if (clearing) "Clearing…" else "Clear downloads", fontWeight = FontWeight.Normal) }
            }
        }
    } }
    issueDraft?.let { draft ->
        MarkIssueSheet(draft, draftError, { updated -> issueDraft = updated; draftError = if (runCatching { store.draft(updated.getString("story"), updated) }.isSuccess) "" else "Couldn’t keep the draft on this phone. Your text stays open. Try saving again." }, { if (runCatching { store.draft(draft.getString("story"), draft) }.isSuccess) issueDraft = null else draftError = "Couldn’t keep the draft on this phone. Try again before closing." }, { if (runCatching { store.draft(draft.getString("story"), null) }.isSuccess) issueDraft = null else draftError = "Couldn’t discard the draft. Try again." }) { kind, note ->
            val selected = draft.optJSONObject("selection")?.let { selectionFromJson(it) }
            val saved = selected != null && runCatching { store.draft(draft.getString("story"), draft) }.isSuccess && (onSaveIssue?.invoke(selected, draft.getDouble("seconds"), kind, note) ?: run { onIssue(selected, draft.getDouble("seconds"), kind, note); true })
            if (saved) issueDraft = null
            saved
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun LibraryPage(state: ListenerUiState, open: (String) -> Unit, play: (Book) -> Unit, menu: (String) -> Unit, refresh: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf("All") }
    val scroll = rememberLazyGridState()
    val wide = androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp >= 700
    val keyboard = LocalSoftwareKeyboardController.current
    val active = state.books.find { it.id == state.selection?.story }
        ?: currentContinuationPositions(state.positions).firstNotNullOfOrNull { point -> state.books.find { it.id == point.optString("story") } }
    val all = state.books + state.catalog.filter { source -> state.books.none { it.id == source.optString("id") } }.map { source -> Book(source.optString("id"), source.optString("title"), source.optString("author"), emptyMap()) }
    val featured = active != null && query.isBlank() && filter == "All"
    val shown = all.filter { book ->
        val started = state.positions.any { it.optString("story") == book.id } || state.selection?.story == book.id
        (!featured || book.id != active?.id) && "${book.title} ${book.author}".contains(query.trim(), true) && (filter == "All" || (filter == "In progress") == started)
    }
    LazyVerticalGrid(columns = GridCells.Fixed(if (wide) 2 else 1), modifier = Modifier.fillMaxSize().testTag("library"), state = scroll, contentPadding = PaddingValues(horizontal = if (wide) 32.dp else 18.dp, vertical = 16.dp), horizontalArrangement = Arrangement.spacedBy(32.dp)) {
        item(span = { GridItemSpan(maxLineSpan) }) { Box(Modifier.fillMaxWidth()) { Box(Modifier.widthIn(max = 480.dp)) { SearchField(query, { query = it }, "Find a book", "Title or author", KeyboardActions(onSearch = { keyboard?.hide() })) } } }
        item(span = { GridItemSpan(maxLineSpan) }) { FilterTabs(listOf("All", "In progress", "Not started"), filter, { filter = it }) }
        if (state.message.isNotEmpty() && state.message != "Your progress is synced.") item(span = { GridItemSpan(maxLineSpan) }) {
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) { Text(state.message, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall); if (!state.loading) TextButton(onClick = refresh) { Text("Retry") } }
        } else if (state.offline) item(span = { GridItemSpan(maxLineSpan) }) { Text("Offline. Showing your saved library.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 8.dp)) }
        if (state.loading && all.isEmpty()) {
            item(span = { GridItemSpan(maxLineSpan) }) { Text("Loading your books…", style = MaterialTheme.typography.bodyMedium) }
            items(3, span = { GridItemSpan(maxLineSpan) }) { Surface(Modifier.fillMaxWidth().padding(vertical = 7.dp).height(76.dp), shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .45f)) {} }
        } else if (all.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
            Column(Modifier.padding(vertical = 32.dp)) { SectionTitle("No books yet"); Text("Your books will appear here after sync.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 8.dp)); TextButton(onClick = refresh) { Text("Sync library") } }
        } else {
            if (featured) item(span = { GridItemSpan(maxLineSpan) }) {
                Column { Text("Keep listening", fontSize = 12.8.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(bottom = 10.dp))
                Surface(modifier = Modifier.widthIn(max = 480.dp).fillMaxWidth(), color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(12.dp)) { BookRow(active, state, { play(active) }, { play(active) }, { menu(active.id) }, true) } }
            }
            item(span = { GridItemSpan(maxLineSpan) }) { Row(Modifier.fillMaxWidth().padding(top = 24.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) { Text(if (featured) "More stories" else "Your books", fontSize = 12.8.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f)); Text("${shown.size}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
            if (shown.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) { Column(Modifier.padding(vertical = 32.dp)) { SectionTitle("No matching books"); Text("Try another title or author, or show all books.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 8.dp)); TextButton(onClick = { query = ""; filter = "All" }) { Text("Show all books") } } }
            items(shown, key = { it.id }) { book -> Column { BookRow(book, state, { open(book.id) }, null, { menu(book.id) }); HorizontalDivider() } }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun BookRow(book: Book, state: ListenerUiState, open: () -> Unit, play: (() -> Unit)?, menu: () -> Unit, featured: Boolean = false) {
    val summary = listeningSummary(book, state)
    val source = state.catalog.find { it.optString("id") == book.id }
    val ready = book.editions.values.any { it.isNotEmpty() }
    val repair = source?.optJSONObject("repair")
    val context = LocalContext.current
    val offline = remember(context) { OfflineAudio(context) }
    Row(Modifier.fillMaxWidth().combinedClickable(role = Role.Button, onClick = open, onLongClick = menu).padding(vertical = 14.dp, horizontal = if (featured) 12.dp else 0.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        StoryCover(book.id, Modifier.size(if (featured) 64.dp else 48.dp, if (featured) 96.dp else 72.dp))
        Column(Modifier.weight(1f)) {
            Text(book.title, fontSize = if (featured) 15.52.sp else 14.08.sp, lineHeight = if (featured) 19.4.sp else 18.3.sp, fontWeight = FontWeight.SemiBold)
            Text(book.author, style = MaterialTheme.typography.bodySmall, fontSize = if (featured) 11.04.sp else 11.52.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp, bottom = 8.dp))
            Text(if (!ready) "Preparing audio" else listeningPlace(book, state, summary.latest), style = MaterialTheme.typography.labelSmall, color = if (featured) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
            Text(if (featured) "${formatRemaining(summary.remaining)} left" else if (ready) "${summary.unread} unplayed · ${formatRemaining(summary.remaining)} left" else source?.optJSONObject("job")?.optString("phase")?.takeIf { it.isNotBlank() } ?: "Audio isn’t ready", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = if (featured) 8.dp else 4.dp))
            if (repair != null) Text(repair.optString("title", "Audio updating") + (if (repair.optInt("total") > 0) " · ${repair.optInt("completed")} of ${repair.optInt("total")} chapters" else ""), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 4.dp))
            if (state.offline) Text(if (ready && book.editions[summary.edition].orEmpty().any(offline::ready)) "Downloaded" else if (ready) "Internet needed" else "Preparation status saved", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 4.dp))
        }
        Column {
            if (featured && play != null) IconButton(onClick = play, enabled = ready) { Box(Modifier.size(38.dp).background(MaterialTheme.colorScheme.primary, CircleShape), contentAlignment = Alignment.Center) { Icon(Icons.Default.PlayArrow, "Continue ${book.title}", tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(24.dp)) } }
            IconButton(onClick = menu) { Icon(Icons.Default.MoreVert, "More options for ${book.title}", modifier = Modifier.size(18.dp)) }
        }
    }
}

@Composable
internal fun StoryCover(story: String, modifier: Modifier) {
    val context = LocalContext.current
    val supplied = LocalStoryCovers.current[story]
    val cover by produceState<ImageBitmap?>(supplied, story, supplied) { if (supplied == null) value = withContext(Dispatchers.IO) { runCatching { ListenerApi(context).cover(story).let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() } }.getOrNull() } }
    val image = supplied ?: cover
    Surface(modifier, color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(4.dp)) { Box(contentAlignment = Alignment.Center) { if (image != null) Image(image, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) else Icon(Icons.AutoMirrored.Filled.LibraryBooks, null, tint = MaterialTheme.colorScheme.onPrimaryContainer) } }
}
@Composable
internal fun StorytellerMark(size: Dp) { Image(painterResource(R.drawable.storyteller_mark), null, Modifier.size(size)) }
