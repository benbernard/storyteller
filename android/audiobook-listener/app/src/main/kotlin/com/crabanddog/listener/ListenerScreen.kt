package com.crabanddog.listener

import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
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
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

internal fun jsonObjects(array: org.json.JSONArray?): List<JSONObject> = (0 until (array?.length() ?: 0)).map { array!!.getJSONObject(it) }
internal data class ListeningSummary(val edition: String, val latest: JSONObject?, val unread: Int, val remaining: Double)
internal fun listeningSummary(book: Book, state: ListenerUiState): ListeningSummary {
    val saved = state.positions.filter { it.optString("story") == book.id }
    val latest = saved.sortedByDescending { it.optLong("deviceTime") }.firstOrNull { p -> book.editions[p.optString("edition")]?.any { it.assembly == p.optString("assembly") } == true }
    val current = state.selection?.takeIf { it.story == book.id }
    val edition = current?.edition ?: latest?.optString("edition") ?: book.defaultEdition.takeIf { book.editions[it]?.isNotEmpty() == true } ?: book.editions.keys.firstOrNull().orEmpty()
    val unread = book.editions[edition].orEmpty().filter { "${book.id}:${it.id}" !in state.completed }
    val remaining = unread.sumOf { chapter ->
        val seconds = if (current?.chapter?.assembly == chapter.assembly) state.position else saved.firstOrNull { it.optString("edition") == edition && it.optString("assembly") == chapter.assembly }?.optDouble("seconds") ?: 0.0
        val view = chapterView(chapter, state.reading, state.includeAuthorNotes)
        (view.duration - view.position(seconds)).coerceAtLeast(0.0)
    }
    return ListeningSummary(edition, current?.location(state.position) ?: latest, unread.size, remaining)
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
        Column(Modifier.widthIn(max = 840.dp).fillMaxSize()) {
            Row(Modifier.fillMaxWidth().heightIn(min = 58.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (state.connected && screen != "library") IconButton(onClick = { back() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                StorytellerMark(32.dp)
                Column(Modifier.weight(1f).padding(horizontal = 8.dp)) {
                    Text(if (!state.connected) "Listener" else when (screen) { "library" -> "Your library"; "listening" -> state.selection?.chapter?.title ?: browsing?.chapter?.title ?: "Listening"; "chapters" -> "Chapters"; "downloads" -> "Downloads"; "preparation" -> "Preparation"; "issues" -> "Marked issues"; "account" -> "Account"; else -> "Book" }, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    if (screen == "listening" && state.connected) Text(state.selection?.bookTitle ?: browsing?.bookTitle.orEmpty(), style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (state.connected) {
                    when (screen) {
                        "listening" -> IconButton(onClick = { sheet = "settings" }) { Icon(Icons.Default.Settings, "Listening settings") }
                        "downloads" -> IconButton(onClick = { sheet = "download-settings" }) { Icon(Icons.Default.Settings, "Download settings") }
                        "preparation" -> IconButton(onClick = { sheet = "preparation-settings" }) { Icon(Icons.Default.Settings, "Preparation settings") }
                        "account" -> Unit
                        else -> IconButton(onClick = onRefresh, enabled = !state.loading) { Icon(Icons.Default.Refresh, "Sync library") }
                    }
                    if (screen == "library") IconButton(onClick = { navigate("account", null) }) { Icon(Icons.Default.MoreVert, "Account") }
                }
            }
            HorizontalDivider()
            if (state.message.isNotEmpty() && state.message != "Your progress is synced.") Text(state.message, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
            if (!state.connected) {
                Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(28.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Spacer(Modifier.height(20.dp)); StorytellerMark(86.dp)
                    Text("Pick up the story", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                    Text("Sign in to open your library and keep your place across devices.", style = MaterialTheme.typography.bodyMedium)
                    if (state.signInUrl.isNotEmpty()) {
                        TextButton(onClick = { uri.openUri(state.signInUrl) }) { Text("Continue sign in") }
                        TextButton(onClick = onCancelSignIn) { Text("Cancel") }
                    } else Button(onClick = onConnect, enabled = !state.signingIn) { Text(if (state.signingIn) "Opening sign in…" else "Sign in") }
                }
            } else {
                holder.SaveableStateProvider(screen + ":" + storyId) {
                    Box(Modifier.weight(1f)) {
                        when (screen) {
                            "library" -> LibraryPage(state, ::openBook, playBook, { menuStory = it })
                            "book" -> BookPage(selectedBook, source, state, playBook, { navigate(it) })
                            "chapters" -> ChaptersPage(selectedBook, state, { selection, playable -> browseJson = selection.json().put("playable", playable).toString(); openReader() }, { book, edition, chapter -> browseJson = null; (onChapterPlay ?: onPlay)(book, edition, chapter); openReader() })
                            "listening" -> ListeningPage(state, browsing, browsingCanPlay, textSize, { if (state.selection == null && browsing != null) { state.books.find { it.id == browsing.story }?.let { onPlay(it, browsing.edition, browsing.chapter); browseJson = null } } else onToggle() }, onSeek, onPassage, onPassageSelection, onSkip, mark, { sheet = "speed" }, { sheet = "history"; onHistory(false) }, { navigate("chapters", state.selection?.story ?: browsing?.story) }, { browseJson = null }, onReturn)
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
                        TextButton(onClick = { browseJson = null; openReader() }, modifier = Modifier.weight(1f).testTag("open-player")) { Column(Modifier.fillMaxWidth()) { Text(selection.bookTitle, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelLarge); Text("${selection.chapter.title} · ${formatTime(state.position)}", maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall) } }
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
        AlertDialog(onDismissRequest = { menuStory = null }, title = { Text(book?.title ?: "Book") }, text = { Column { TextButton(onClick = { menuStory = null; navigate("downloads", id) }, enabled = book != null) { Text("Downloads") }; TextButton(onClick = { menuStory = null; clearStory = id }, enabled = book != null) { Text("Clear downloads") } } }, confirmButton = { TextButton(onClick = { menuStory = null }) { Text("Close") } })
    }
    clearStory?.let { id -> state.books.find { it.id == id }?.let { book ->
        AlertDialog(onDismissRequest = { clearStory = null }, title = { Text("Clear downloads?") }, text = { Column { Text("Remove downloaded audio for ${book.title} from this phone? Downloads for this book will pause. Your listening place is kept."); if (clearError.isNotEmpty()) Text(clearError, color = MaterialTheme.colorScheme.error) } }, confirmButton = { TextButton(onClick = { val books = state.books; clearing = true; clearError = ""; scope.launch { try { withContext(Dispatchers.IO) { offline.clearBook(book, books) }; clearStory = null } catch (e: Exception) { clearError = "Couldn’t clear all downloads. Try again." } finally { clearing = false } } }, enabled = !clearing) { Text(if (clearing) "Clearing…" else "Clear downloads") } }, dismissButton = { TextButton(onClick = { clearStory = null }) { Text("Keep downloads") } })
    } }
    issueDraft?.let { draft ->
        MarkIssueSheet(draft, draftError, { updated -> issueDraft = updated; draftError = if (runCatching { store.draft(updated.getString("story"), updated) }.isSuccess) "" else "Couldn’t keep the draft on this phone. Your text stays open. Try saving again." }, { issueDraft = null }, { store.draft(draft.getString("story"), null); issueDraft = null }) { kind, note ->
            val selected = draft.optJSONObject("selection")?.let { selectionFromJson(it) }
            val saved = selected != null && runCatching { store.draft(draft.getString("story"), draft) }.isSuccess && (onSaveIssue?.invoke(selected, draft.getDouble("seconds"), kind, note) ?: run { onIssue(selected, draft.getDouble("seconds"), kind, note); true })
            if (saved) issueDraft = null
            saved
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun LibraryPage(state: ListenerUiState, open: (String) -> Unit, play: (Book) -> Unit, menu: (String) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf("All") }
    val scroll = rememberLazyListState()
    val keyboard = LocalSoftwareKeyboardController.current
    val active = state.books.find { it.id == state.selection?.story }
    val matches: (String, String, Boolean) -> Boolean = { title, author, started -> "$title $author".contains(query.trim(), true) && (filter == "All" || (filter == "In progress") == started) }
    LazyColumn(Modifier.fillMaxSize().testTag("library"), state = scroll, contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { OutlinedTextField(query, { query = it }, label = { Text("Find a book") }, placeholder = { Text("Title or author") }, leadingIcon = { Icon(Icons.Default.Search, null) }, trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Default.Close, "Clear search") } }, singleLine = true, keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }), modifier = Modifier.fillMaxWidth()) }
        item { Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf("All", "In progress", "Not started").forEach { option -> FilterChip(selected = filter == option, onClick = { filter = option }, label = { Text(option) }) } } }
        if (state.offline) item { Text("Offline · showing your saved library", style = MaterialTheme.typography.bodySmall) }
        if (active != null && query.isBlank() && filter == "All") item {
            Text("Keep listening", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp, bottom = 12.dp))
            Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = RoundedCornerShape(16.dp)) { BookRow(active, state, { open(active.id) }, { play(active) }, { menu(active.id) }) }
            Text("More stories", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 24.dp, bottom = 8.dp))
        }
        val shown = state.books.filter { (it != active || query.isNotBlank() || filter != "All") && matches(it.title, it.author, state.positions.any { p -> p.optString("story") == it.id } || state.selection?.story == it.id) }
        items(shown, key = { it.id }) { book -> BookRow(book, state, { open(book.id) }, { play(book) }, { menu(book.id) }); HorizontalDivider() }
        val preparing = state.catalog.filter { source -> state.books.none { it.id == source.optString("id") } && source.optJSONObject("follow") != null && matches(source.optString("title"), source.optString("author"), false) }
        items(preparing, key = { it.optString("id") }) { source ->
            TextButton(onClick = { open(source.getString("id")) }, modifier = Modifier.fillMaxWidth()) { Column(Modifier.fillMaxWidth()) { Text(source.optString("title"), style = MaterialTheme.typography.titleSmall); Text("Audio is preparing", style = MaterialTheme.typography.bodySmall) } }
        }
        if (shown.isEmpty() && preparing.isEmpty() && !(active != null && query.isBlank() && filter == "All")) item { Text(if (state.loading) "Loading your books…" else if (state.books.isEmpty() && query.isBlank()) "No books yet. Your prepared stories will appear here." else "No matching books. Try another title or author.", style = MaterialTheme.typography.bodyMedium) }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun BookRow(book: Book, state: ListenerUiState, open: () -> Unit, play: (() -> Unit)?, menu: () -> Unit) {
    val summary = listeningSummary(book, state)
    Row(Modifier.fillMaxWidth().combinedClickable(onClick = open, onLongClick = menu).padding(vertical = 12.dp, horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        StoryCover(book.id, Modifier.size(52.dp, 76.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(book.title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Text(book.author, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(summary.latest?.let { "${book.editions[summary.edition]?.find { c -> c.assembly == it.optString("assembly") }?.title ?: "Your place"} · ${formatTime(it.optDouble("seconds"))}" } ?: "Not started", style = MaterialTheme.typography.labelSmall)
            Text("${summary.unread} unplayed · ${formatTime(summary.remaining)} left", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Column {
            if (play != null) IconButton(onClick = play, enabled = book.editions[summary.edition]?.isNotEmpty() == true) { Box(Modifier.size(40.dp).background(MaterialTheme.colorScheme.primary, CircleShape), contentAlignment = Alignment.Center) { Icon(Icons.Default.PlayArrow, "${if (summary.latest != null) "Continue" else "Play"} ${book.title}", tint = MaterialTheme.colorScheme.onPrimary) } }
            IconButton(onClick = menu) { Icon(Icons.Default.MoreVert, "More options for ${book.title}", modifier = Modifier.size(20.dp)) }
        }
    }
}

@Composable
internal fun StoryCover(story: String, modifier: Modifier) {
    val context = LocalContext.current
    val cover by produceState<ImageBitmap?>(null, story) { value = withContext(Dispatchers.IO) { runCatching { ListenerApi(context).cover(story).let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() } }.getOrNull() } }
    Surface(modifier, color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(6.dp)) { Box(contentAlignment = Alignment.Center) { if (cover != null) Image(cover!!, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) else Icon(Icons.AutoMirrored.Filled.LibraryBooks, null, tint = MaterialTheme.colorScheme.onPrimaryContainer) } }
}
@Composable
internal fun StorytellerMark(size: Dp) { Image(painterResource(R.drawable.storyteller_mark), null, Modifier.size(size)) }
