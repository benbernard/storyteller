package com.crabanddog.listener

import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ListeningPage(state: ListenerUiState, browsing: Selection?, browsingCanPlay: Boolean, size: Float, toggle: () -> Unit, seek: (Double) -> Unit,
    passage: (Double) -> Unit, passageSelection: ((Selection, Double) -> Unit)?, skip: ((Int) -> Unit)?, mark: () -> Unit,
    speed: () -> Unit, history: () -> Unit, chapters: () -> Unit, backToAudio: () -> Unit, restore: (JSONObject) -> Unit) {
    val context = LocalContext.current
    val store = remember(context) { ListenerStore.get(context) }
    val display = browsing ?: state.selection
    val assembly = display?.chapter?.assembly
    var loaded by remember(assembly) { mutableStateOf<Reading?>(assembly?.let { store.reading(it)?.let(::readingFromJson) }) }
    var textError by remember(assembly) { mutableStateOf("") }
    var follow by rememberSaveable(assembly) { mutableStateOf(browsing == null) }
    var jump by remember(assembly) { mutableIntStateOf(0) }
    LaunchedEffect(assembly, state.reading) {
        if (display == null) return@LaunchedEffect
        if (state.reading?.assembly == assembly) loaded = state.reading
        else try { val data = ListenerApi(context).call("/stories/${display.story}/${display.edition}/text/$assembly"); store.reading(assembly!!, data); loaded = readingFromJson(data) }
        catch (e: Exception) { if (loaded == null) textError = "Text is unavailable. Your audio has not moved." }
    }
    val reading = state.reading?.takeIf { it.assembly == assembly } ?: loaded
    val followsAudio = browsing == null && follow
    val audioSelection = state.selection
    val view = audioSelection?.let { chapterView(it.chapter, state.reading, state.includeAuthorNotes) }
    var draggedPosition by remember { mutableStateOf<Float?>(null) }
    var outputError by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
        if (reading == null) Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) { Text(textError.ifEmpty { if (display == null) "Choose a chapter from your library." else "Loading chapter text…" }, style = MaterialTheme.typography.bodyMedium) }
        else PassageText(reading, state.position, followsAudio, browsing == null, state.includeAuthorNotes, size, jump, { follow = false }, Modifier.weight(1f)) { seconds ->
            if (!browsingCanPlay) textError = "Audio isn’t ready in this edition. Your current audio has not moved."
            else if (display != null && browsing != null && passageSelection != null) passageSelection(display, seconds) else passage(seconds)
        }
        if (reading != null && textError.isNotEmpty()) Text(textError, style = MaterialTheme.typography.bodySmall)
        HorizontalDivider()
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(formatTime(view?.position(state.position) ?: 0.0), style = MaterialTheme.typography.labelSmall)
            Spacer(Modifier.weight(1f))
            Text("−${formatTime(((view?.duration ?: 0.0) - (view?.position(state.position) ?: 0.0)).coerceAtLeast(0.0))}", style = MaterialTheme.typography.labelSmall)
            Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) { state.undo?.takeIf { it.optString("story") == audioSelection?.story }?.let { undo -> IconButton(onClick = { restore(undo) }, enabled = !state.returning) { Icon(Icons.AutoMirrored.Filled.Undo, "Undo jump", modifier = Modifier.size(20.dp)) } } }
        }
        Slider(thumb = { Box(Modifier.size(12.dp).background(MaterialTheme.colorScheme.primary, CircleShape)) }, track = { slider -> SliderDefaults.Track(sliderState = slider, modifier = Modifier.height(4.dp), thumbTrackGapSize = 0.dp, drawStopIndicator = null) }, value = draggedPosition ?: (view?.position(state.position)?.toFloat() ?: 0f).coerceIn(0f, view?.duration?.toFloat()?.coerceAtLeast(1f) ?: 1f), onValueChange = { draggedPosition = it }, onValueChangeFinished = { draggedPosition?.let { seek(view?.source(it.toDouble()) ?: it.toDouble()) }; draggedPosition = null }, valueRange = 0f..(view?.duration?.toFloat()?.coerceAtLeast(1f) ?: 1f), enabled = audioSelection != null, modifier = Modifier.fillMaxWidth().height(32.dp).semantics { contentDescription = "Chapter position" })
        Box(Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            IconButton(onClick = {
                val shown = if (Build.VERSION.SDK_INT >= 34) runCatching { android.media.MediaRouter2.getInstance(context).showSystemOutputSwitcher() }.getOrDefault(false) else false
                if (!shown) runCatching { context.startActivity(Intent(Settings.Panel.ACTION_VOLUME)) }.onFailure { outputError = true }
            }, modifier = Modifier.align(Alignment.CenterStart)) { Icon(Icons.Default.Speaker, "Audio output", modifier = Modifier.size(22.dp)) }
            Row(Modifier.align(Alignment.Center), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { skip?.invoke(-15) ?: seek((state.position - 15).coerceAtLeast(0.0)) }, enabled = audioSelection != null) { Icon(Icons.Default.Replay, "Back 15 seconds", modifier = Modifier.size(22.dp)) }
                IconButton(onClick = toggle, enabled = audioSelection != null || browsing != null && browsingCanPlay) { Box(Modifier.size(40.dp).background(MaterialTheme.colorScheme.primary, CircleShape), contentAlignment = Alignment.Center) { Icon(if (state.playing) Icons.Default.Pause else Icons.Default.PlayArrow, if (state.playing) "Pause" else "Play", tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(26.dp)) } }
                IconButton(onClick = { skip?.invoke(30) ?: seek(state.position + 30) }, enabled = audioSelection != null) { Icon(Icons.Default.Forward30, "Ahead 30 seconds", modifier = Modifier.size(22.dp)) }
            }
            IconButton(onClick = mark, enabled = audioSelection != null, modifier = Modifier.align(Alignment.CenterEnd)) { Icon(Icons.Default.Flag, "Mark issue", modifier = Modifier.size(22.dp)) }
        }
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { backToAudio(); follow = true; jump++ }, enabled = audioSelection != null, modifier = Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 0.dp)) { Text(if (followsAudio) "Following audio" else "Back to audio", style = MaterialTheme.typography.labelMedium) }
            TextButton(onClick = speed, contentPadding = PaddingValues(horizontal = 6.dp)) { Text("${speedLabel(state.speed)}×", style = MaterialTheme.typography.labelMedium) }
            IconButton(onClick = chapters) { Icon(Icons.AutoMirrored.Filled.List, "Browse chapters", modifier = Modifier.size(22.dp)) }
            IconButton(onClick = history, enabled = audioSelection != null) { Icon(Icons.Default.History, "Recent jumps", modifier = Modifier.size(22.dp)) }
        }
    }
    if (outputError) AlertDialog(onDismissRequest = { outputError = false }, title = { Text("Audio output") }, text = { Text("The system output selector is unavailable. Choose an audio device from your phone’s media controls.") }, confirmButton = { TextButton(onClick = { outputError = false }) { Text("Close") } })
}

@Composable
private fun PassageText(reading: Reading, position: Double, follow: Boolean, highlightAudio: Boolean, includeNotes: Boolean, size: Float, jump: Int, stopFollowing: () -> Unit, modifier: Modifier, tap: (Double) -> Unit) {
    val paragraphs = remember(reading, includeNotes) { bookParagraphs(reading, includeNotes) }
    val scroll = rememberLazyListState()
    val dragged by scroll.interactionSource.collectIsDraggedAsState()
    val visible = reading.passages.filter { includeNotes || it.sectionKind != "author-note" }
    val active = if (highlightAudio) visible.lastOrNull { it.start <= position } ?: visible.firstOrNull() else null
    val target = paragraphs.indexOfFirst { paragraph -> paragraph.fragments.any { it.passage.id == active?.id } }
    val layouts = remember(reading.assembly) { mutableStateMapOf<Int, TextLayoutResult>() }
    val activeLayout = layouts[target]
    LaunchedEffect(dragged) { if (dragged) stopFollowing() }
    LaunchedEffect(active?.id, follow, reading.assembly, includeNotes, jump, activeLayout?.size) {
        if (follow && target >= 0) {
            val fragment = paragraphs[target].fragments.firstOrNull { it.passage.id == active?.id }
            val offset = if (fragment != null && activeLayout != null) activeLayout.getLineTop(activeLayout.getLineForOffset(fragment.start)).toInt().coerceAtLeast(0) else 0
            val item = scroll.layoutInfo.visibleItemsInfo.find { it.index == target }
            if (item == null || item.offset + offset < 0 || item.offset + offset >= scroll.layoutInfo.viewportEndOffset - 32) scroll.animateScrollToItem(target, offset)
        }
    }
    LazyColumn(modifier.fillMaxWidth().testTag("passages"), state = scroll, contentPadding = PaddingValues(top = 14.dp, bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        itemsIndexed(paragraphs) { index, paragraph ->
            val highlight = MaterialTheme.colorScheme.primary.copy(alpha = .08f)
            val text = buildAnnotatedString { append(paragraph.text); paragraph.fragments.filter { it.passage.id == active?.id }.forEach { addStyle(SpanStyle(background = highlight), it.start, it.end) } }
            Text(text, fontFamily = FontFamily.Serif, fontSize = size.sp, letterSpacing = 0.sp, lineHeight = (size * 1.6).sp, onTextLayout = { if (layouts[index]?.layoutInput != it.layoutInput) layouts[index] = it }, modifier = Modifier.fillMaxWidth().pointerInput(paragraph) {
                detectTapGestures { point -> layouts[index]?.getOffsetForPosition(point)?.let { offset -> paragraph.fragments.firstOrNull { offset >= it.start && offset < it.end }?.let { tap(it.passage.start) } } }
            }.semantics {
                selected = paragraph.fragments.any { it.passage.id == active?.id }
                onClick(label = "Listen from this paragraph") { paragraph.fragments.firstOrNull()?.let { tap(it.passage.start) }; true }
                customActions = paragraph.fragments.distinctBy { it.passage.id }.map { fragment -> CustomAccessibilityAction("Listen from ${formatTime(fragment.passage.start)}") { tap(fragment.passage.start); true } }
            })
        }
    }
}

@Composable
internal fun ListeningSettings(state: ListenerUiState, size: Float, changeSize: (Float) -> Unit, edition: (String) -> Unit, includeNotes: (Boolean) -> Unit, dismiss: () -> Unit) {
    val book = state.books.find { it.id == state.selection?.story }
    AlertDialog(onDismissRequest = dismiss, title = { Text("Listening settings") }, text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Edition", style = MaterialTheme.typography.titleSmall)
        book?.editions?.forEach { (name, chapters) -> Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(selected = state.selection?.edition == name, enabled = !state.switchingEdition && chapters.any { it.id == state.selection?.chapter?.id }, role = Role.RadioButton, onClick = { edition(name) }), verticalAlignment = Alignment.CenterVertically) { RadioButton(selected = state.selection?.edition == name, onClick = null); Text(editionName(name)) } }
        if (state.switchingEdition) Text("Changing edition…", style = MaterialTheme.typography.bodySmall)
        HorizontalDivider(); Text("Text size", style = MaterialTheme.typography.titleSmall)
        Row(verticalAlignment = Alignment.CenterVertically) { IconButton(onClick = { changeSize((size - 2).coerceAtLeast(12f)) }, enabled = size > 12) { Icon(Icons.Default.TextDecrease, "Decrease text size") }; Text("Aa", modifier = Modifier.weight(1f), fontFamily = FontFamily.Serif, fontSize = size.sp); IconButton(onClick = { changeSize((size + 2).coerceAtMost(28f)) }, enabled = size < 28) { Icon(Icons.Default.TextIncrease, "Increase text size") } }
        Text("The light swept across the harbour as June opened the letter.", fontSize = size.sp, fontFamily = FontFamily.Serif, lineHeight = (size * 1.6).sp)
        HorizontalDivider(); AuthorNoteSetting(state.includeAuthorNotes, includeNotes)
    } }, confirmButton = { TextButton(onClick = dismiss) { Text("Close") } })
}
@Composable
fun AuthorNoteSetting(include: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(value = include, role = Role.Checkbox, onValueChange = onChange).testTag("include-author-notes"), verticalAlignment = Alignment.CenterVertically) { Checkbox(include, null); Text("Include author notes", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = 8.dp)) }
}
internal fun speedLabel(value: Float): String = String.format(java.util.Locale.ROOT, "%.2f", value).trimEnd('0').trimEnd('.')
@Composable
internal fun SpeedSettings(current: Float, change: (Float) -> Unit, dismiss: () -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    var custom by remember { mutableStateOf(speedLabel(current)) }
    val parsed = custom.replace(',', '.').toFloatOrNull()?.takeIf { it.isFinite() && it in .1f..4f }
    AlertDialog(onDismissRequest = dismiss, title = { Text("Playback speed") }, text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Box { TextButton(onClick = { expanded = true }) { Text("${speedLabel(current)}×"); Icon(Icons.Default.ExpandMore, null) }; DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, modifier = Modifier.heightIn(max = 320.dp)) { (8..25).forEach { tenth -> DropdownMenuItem(text = { Text("${speedLabel(tenth / 10f)}×") }, onClick = { change(tenth / 10f); expanded = false; dismiss() }) } } }
        OutlinedTextField(custom, { custom = it }, label = { Text("Custom speed") }, suffix = { Text("×") }, isError = parsed == null, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), singleLine = true)
        Text("0.1–4×", style = MaterialTheme.typography.bodySmall)
    } }, confirmButton = { TextButton(onClick = { parsed?.let(change); dismiss() }, enabled = parsed != null) { Text("Apply") } }, dismissButton = { TextButton(onClick = dismiss) { Text("Close") } })
}

@Composable
internal fun RecentJumps(state: ListenerUiState, dismiss: () -> Unit, restore: (JSONObject) -> Unit, earlier: () -> Unit) {
    val context = LocalContext.current
    val store = remember(context) { ListenerStore.get(context) }; val audio = remember(context) { OfflineAudio(context) }
    val initialVersion = remember { state.returnVersion }
    LaunchedEffect(state.returnVersion) { if (state.returnVersion != initialVersion) dismiss() }
    val story = state.selection?.story
    val rows = (state.localJumps + state.history).filter { it.optJSONObject("from")?.optString("story") == story }.sortedByDescending { it.optLong("deviceTime") }.distinctBy { entry -> val from = entry.getJSONObject("from"); from.optString("assembly") + from.optString("edition") + (from.optDouble("seconds") * 100).toLong() + ":" + entry.optLong("deviceTime") / 1000 }
    AlertDialog(onDismissRequest = dismiss, title = { Text("Recent jumps") }, text = { Column { if (state.returning) LinearProgressIndicator(Modifier.fillMaxWidth()); if (rows.isEmpty()) Text("Places you leave when you jump will appear here.", style = MaterialTheme.typography.bodyMedium); LazyColumn(Modifier.heightIn(max = 420.dp)) { itemsIndexed(rows) { _, entry -> val point = entry.getJSONObject("from"); val cached = store.reading(point.optString("assembly")); val snapshot = point.optJSONObject("selection")?.optJSONObject("chapter"); val checksum = snapshot?.optString("checksum")?.takeIf { it.isNotEmpty() } ?: cached?.optString("checksum").orEmpty(); val available = !state.offline || cached != null && audio.ready(Chapter("", 0, "", point.optString("assembly"), 0.0, checksum)); TextButton(onClick = { restore(point) }, enabled = !state.returning && available, modifier = Modifier.fillMaxWidth()) { Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) { Text(point.optString("chapterTitle", "Saved passage"), style = MaterialTheme.typography.titleSmall); Text("${formatTime(point.optDouble("seconds"))} · ${editionName(point.optString("edition"))}", style = MaterialTheme.typography.labelSmall); if (point.optString("excerpt").isNotBlank()) Text(point.optString("excerpt"), style = MaterialTheme.typography.bodySmall, maxLines = 3); Text(java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT).format(java.util.Date(entry.optLong("deviceTime"))), style = MaterialTheme.typography.labelSmall); if (!available) Text("Download this recording and its text to return offline.", style = MaterialTheme.typography.labelSmall) } }; HorizontalDivider() }; if (state.historyBefore != null) item { TextButton(onClick = earlier) { Text("Earlier jumps") } } } } }, confirmButton = { TextButton(onClick = dismiss) { Text("Close") } })
}

@Composable
internal fun MarkIssueSheet(draft: JSONObject, draftError: String, update: (JSONObject) -> Unit, dismiss: () -> Unit, discard: () -> Unit, save: (String, String) -> Boolean) {
    var expanded by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val kinds = listOf("voice" to "Wrong voice", "pronunciation" to "Pronunciation", "missing" to "Missing or repeated text", "delivery" to "Delivery or pacing", "other" to "Other")
    AlertDialog(onDismissRequest = dismiss, title = { Text("Mark issue") }, text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(draft.optString("bookTitle", draft.optJSONObject("selection")?.optString("bookTitle").orEmpty()), style = MaterialTheme.typography.titleSmall)
        if (draft.optString("excerpt").isNotBlank()) Text(draft.optString("excerpt"), style = MaterialTheme.typography.bodySmall, maxLines = 3)
        Text("${draft.optString("chapterTitle")} · ${formatTime(draft.optDouble("seconds"))} · ${editionName(draft.optString("edition"))}", style = MaterialTheme.typography.bodySmall)
        Box { TextButton(onClick = { expanded = true }) { Text(kinds.find { it.first == draft.optString("kind") }?.second ?: "Wrong voice"); Icon(Icons.Default.ExpandMore, null) }; DropdownMenu(expanded, { expanded = false }) { kinds.forEach { (id, title) -> DropdownMenuItem(text = { Text(title) }, onClick = { update(JSONObject(draft.toString()).put("kind", id)); expanded = false }) } } }
        OutlinedTextField(draft.optString("note"), { value -> if (value.length <= 2000) update(JSONObject(draft.toString()).put("note", value)) }, label = { Text("Optional note") }, minLines = 2, maxLines = 6, modifier = Modifier.fillMaxWidth())
        if (draftError.isNotEmpty()) Text(draftError, color = MaterialTheme.colorScheme.error)
        if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
        TextButton(onClick = discard, enabled = !saving) { Text("Discard draft") }
    } }, confirmButton = { TextButton(onClick = { if (!saving) { saving = true; if (!save(draft.optString("kind", "voice"), draft.optString("note"))) { saving = false; error = "Couldn’t save on this phone. Your draft is kept. Try again." } } }, enabled = !saving) { Text("Save issue") } }, dismissButton = { TextButton(onClick = dismiss) { Text("Close") } })
}
