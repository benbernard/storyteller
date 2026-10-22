package com.crabanddog.listener

import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
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
import androidx.compose.ui.focus.focusRequester
import org.json.JSONObject

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun ListeningPage(state: ListenerUiState, browsing: Selection?, browsingCanPlay: Boolean, size: Float, toggle: () -> Unit, seek: (Double) -> Unit,
    passage: (Double) -> Unit, passageSelection: ((Selection, Double) -> Unit)?, skip: ((Int) -> Unit)?, mark: () -> Unit,
    speed: () -> Unit, history: () -> Unit, chapters: () -> Unit, backToAudio: () -> Unit, restore: (JSONObject) -> Unit,
    browseAdjacent: ((Selection, Boolean) -> Unit)? = null, retryIssues: () -> Unit = {}) {
    val context = LocalContext.current
    val store = remember(context) { ListenerStore.get(context) }
    var issueRevision by remember { mutableIntStateOf(0) }
    DisposableEffect(store) { val listener = android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> issueRevision++ }; store.observeSettings(listener); onDispose { store.stopObservingSettings(listener) } }
    val draft = remember(issueRevision, state.selection?.story) { state.selection?.story?.let(store::draft) }
    val waiting = remember(issueRevision, state.pending, state.selection?.story) { store.pendingIssues().count { it.optString("story") == state.selection?.story } }
    val display = browsing ?: state.selection
    val assembly = display?.chapter?.assembly
    var loaded by remember(assembly) { mutableStateOf<Reading?>(assembly?.let { store.reading(it)?.let(::readingFromJson) }) }
    var textError by remember(assembly) { mutableStateOf("") }
    var readingRetry by remember(assembly) { mutableIntStateOf(0) }
    var follow by rememberSaveable(assembly) { mutableStateOf(browsing == null) }
    var jump by remember(assembly) { mutableIntStateOf(0) }
    LaunchedEffect(assembly, state.reading, readingRetry) {
        textError = "";
        if (display == null) return@LaunchedEffect
        if (state.reading?.assembly == assembly) loaded = state.reading
        else if (loaded == null && state.offline) textError = "Text isn’t downloaded for this chapter. Connect and retry."
        else if (loaded == null) try { val data = ListenerApi(context).call("/stories/${display.story}/${display.edition}/text/$assembly"); store.reading(assembly!!, data); loaded = readingFromJson(data) }
        catch (e: Exception) { if (loaded == null) textError = "Text is unavailable. Your audio has not moved." }
    }
    val reading = state.reading?.takeIf { it.assembly == assembly } ?: loaded
    val followsAudio = browsing == null && follow
    val audioSelection = state.selection
    val view = audioSelection?.let { chapterView(it.chapter, state.reading, state.includeAuthorNotes) }
    var draggedPosition by remember { mutableStateOf<Float?>(null) }
    var outputError by remember { mutableStateOf(false) }
    val book = state.books.find { it.id == display?.story }
    val chapterList = book?.editions?.values?.flatten()?.distinctBy { it.id }?.sortedBy { it.sequence }.orEmpty()
    val chapterIndex = chapterList.indexOfFirst { it.id == display?.chapter?.id }
    fun adjacent(delta: Int) {
        val candidate = chapterList.getOrNull(chapterIndex + delta) ?: return
        val available = book?.editions?.get(display?.edition).orEmpty().find { it.id == candidate.id }
        val edition = if (available != null) display!!.edition else book?.editions?.entries?.firstOrNull { (_, list) -> list.any { it.assembly == candidate.assembly } }?.key ?: return
        browseAdjacent?.invoke(Selection(book!!.id, book.title, edition, available ?: candidate), available != null)
    }
    Column(Modifier.fillMaxSize()) {
        if (reading == null) Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) { Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(20.dp)) { Text(textError.ifEmpty { if (display == null) "Choose a chapter from your library." else "Loading chapter text…" }, style = MaterialTheme.typography.bodyMedium); if (textError.isNotEmpty()) TextButton(onClick = { readingRetry++ }) { Text("Retry text") } } }
        else if (reading.passages.isEmpty()) Box(Modifier.weight(1f).fillMaxWidth().padding(20.dp), contentAlignment = Alignment.Center) { Text("Text is unavailable for this chapter. Audio can still play.", style = MaterialTheme.typography.bodyMedium) }
        else PassageText(reading, state.position, followsAudio, browsing == null || browsing.chapter.assembly == audioSelection?.chapter?.assembly, state.includeAuthorNotes, size, jump, { follow = false }, Modifier.weight(1f), browsing?.takeUnless { it.chapter.assembly == audioSelection?.chapter?.assembly },
            if (chapterIndex > 0 && browseAdjacent != null) ({ adjacent(-1) }) else null,
            if (chapterIndex in 0 until chapterList.lastIndex && browseAdjacent != null) ({ adjacent(1) }) else null) { seconds ->
            if (!browsingCanPlay) textError = "Audio isn’t ready in this edition. Your current audio has not moved."
            else if (display != null && browsing != null && passageSelection != null) passageSelection(display, seconds) else passage(seconds)
        }
        if (reading != null && textError.isNotEmpty()) Text(textError, style = MaterialTheme.typography.bodySmall)
        HorizontalDivider()
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 8.dp)) {
          FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, itemVerticalAlignment = Alignment.CenterVertically) {
            Text(if (followsAudio) "Following audio" else "Browsing text", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            if (!followsAudio) TextButton(onClick = { backToAudio(); follow = true; jump++ }, enabled = audioSelection != null, contentPadding = PaddingValues(horizontal = 2.dp)) { Text("Back to audio", style = MaterialTheme.typography.labelMedium) }
            state.undo?.takeIf { it.optString("story") == audioSelection?.story }?.let { undo -> IconButton(onClick = { restore(undo) }, enabled = !state.returning) { Icon(Icons.AutoMirrored.Filled.Undo, "Undo jump", modifier = Modifier.size(18.dp)) } }
            IconButton(onClick = mark, enabled = audioSelection != null) { Icon(Icons.Default.Flag, draft?.let { "Continue issue draft at ${formatTime(it.optDouble("seconds"))}" } ?: "Mark issue", modifier = Modifier.size(20.dp)) }
            IconButton(onClick = history, enabled = audioSelection != null) { Icon(Icons.Default.History, "Recent jumps", modifier = Modifier.size(22.dp)) }
          }
          CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides androidx.compose.ui.unit.Dp.Unspecified) {
            Slider(thumb = { Box(Modifier.size(12.dp).background(MaterialTheme.colorScheme.primary, CircleShape)) }, track = { slider -> SliderDefaults.Track(sliderState = slider, modifier = Modifier.height(4.dp), thumbTrackGapSize = 0.dp, drawStopIndicator = null) }, value = draggedPosition ?: (view?.position(state.position)?.toFloat() ?: 0f).coerceIn(0f, view?.duration?.toFloat()?.coerceAtLeast(1f) ?: 1f), onValueChange = { draggedPosition = it }, onValueChangeFinished = { draggedPosition?.let { seek(view?.source(it.toDouble()) ?: it.toDouble()) }; draggedPosition = null }, valueRange = 0f..(view?.duration?.toFloat()?.coerceAtLeast(1f) ?: 1f), enabled = audioSelection != null, modifier = Modifier.fillMaxWidth().height(24.dp).semantics { contentDescription = "Chapter position" })
          }
          Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(formatTime(view?.position(state.position) ?: 0.0), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(formatTime(view?.duration ?: 0.0), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
          Row(Modifier.widthIn(max = 360.dp).fillMaxWidth().align(Alignment.CenterHorizontally), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = speed, modifier = Modifier.size(48.dp), contentPadding = PaddingValues(horizontal = 2.dp)) { Text("${speedLabel(state.speed)}×", style = MaterialTheme.typography.labelMedium) }
            IconButton(onClick = { skip?.invoke(-15) ?: seek((state.position - 15).coerceAtLeast(0.0)) }, enabled = audioSelection != null) { Icon(Icons.Default.Replay, "Back 15 seconds", modifier = Modifier.size(22.dp)) }
            IconButton(onClick = toggle, enabled = audioSelection != null || browsing != null && browsingCanPlay) { Box(Modifier.size(40.dp).background(MaterialTheme.colorScheme.primary, CircleShape), contentAlignment = Alignment.Center) { Icon(if (state.playing) Icons.Default.Pause else Icons.Default.PlayArrow, if (state.playing) "Pause" else "Play", tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(26.dp)) } }
            IconButton(onClick = { skip?.invoke(30) ?: seek(state.position + 30) }, enabled = audioSelection != null) { Icon(Icons.Default.Forward30, "Ahead 30 seconds", modifier = Modifier.size(22.dp)) }
            IconButton(onClick = {
                val shown = if (Build.VERSION.SDK_INT >= 34) runCatching { android.media.MediaRouter2.getInstance(context).showSystemOutputSwitcher() }.getOrDefault(false) else false
                if (!shown) runCatching { context.startActivity(Intent(Settings.Panel.ACTION_VOLUME)) }.onFailure { outputError = true }
            }) { Icon(Icons.Default.Speaker, "Audio output", modifier = Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary) }
          }
          if (waiting > 0 || state.message.startsWith("Issue saved at")) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
              Text(if (waiting > 0) "Saved on this phone · $waiting waiting to sync" else state.message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
              if (waiting > 0 && !state.offline) TextButton(onClick = retryIssues, enabled = !state.loading, contentPadding = PaddingValues(horizontal = 4.dp)) { Text("Retry", style = MaterialTheme.typography.bodySmall) }
          }
        }
    }
    if (outputError) ListenerSheet("Audio output", { outputError = false }) { Text("The system output selector is unavailable. Choose an audio device from your phone’s media controls.", style = MaterialTheme.typography.bodyMedium) }
}

@Composable
private fun PassageText(reading: Reading, position: Double, follow: Boolean, highlightAudio: Boolean, includeNotes: Boolean, size: Float, jump: Int, stopFollowing: () -> Unit, modifier: Modifier, browsing: Selection?, previous: (() -> Unit)?, next: (() -> Unit)?, tap: (Double) -> Unit) {
    val paragraphs = remember(reading, includeNotes) { bookParagraphs(reading, includeNotes) }
    val scroll = key(reading.assembly) { rememberLazyListState() }
    val dragged by scroll.interactionSource.collectIsDraggedAsState()
    val visible = reading.passages.filter { includeNotes || it.sectionKind != "author-note" }
    val active = if (highlightAudio) visible.lastOrNull { it.start <= position } ?: visible.firstOrNull() else null
    val target = paragraphs.indexOfFirst { paragraph -> paragraph.fragments.any { it.passage.id == active?.id } }
    val layouts = remember(reading.assembly) { mutableStateMapOf<Int, TextLayoutResult>() }
    val activeLayout = layouts[target]
    var viewportHeight by remember { mutableIntStateOf(0) }
    val preferredInset = with(LocalDensity.current) { 75.dp.roundToPx() }
    val contentInset = with(LocalDensity.current) { 20.dp.roundToPx() }
    val contextInset = (if (viewportHeight > 0) minOf(preferredInset, viewportHeight / 4) else preferredInset) - contentInset
    LaunchedEffect(dragged) { if (dragged) stopFollowing() }
    LaunchedEffect(active?.id, follow, reading.assembly, includeNotes, jump, activeLayout?.size, contextInset) {
        if (follow && target >= 0) {
            val fragment = paragraphs[target].fragments.firstOrNull { it.passage.id == active?.id }
            val offset = if (fragment != null && activeLayout != null) activeLayout.getLineTop(activeLayout.getLineForOffset(fragment.start)).toInt().coerceAtLeast(0) else 0
            scroll.animateScrollToItem(target, offset - contextInset)
        }
    }
    val maxMeasure = (size * LocalDensity.current.fontScale * 31).dp
    val mint = MaterialTheme.colorScheme.primaryContainer
    val teal = MaterialTheme.colorScheme.primary
    LazyColumn(modifier.fillMaxWidth().onSizeChanged { viewportHeight = it.height }.testTag("passages"), state = scroll, contentPadding = PaddingValues(horizontal = 18.dp, vertical = 20.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (browsing != null) item { Column(Modifier.widthIn(max = maxMeasure).fillMaxWidth().padding(horizontal = 12.dp)) { Text("Browsing · Chapter ${browsing.chapter.sequence}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant); Text(browsing.chapter.title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(top = 8.dp, bottom = 12.dp)) } }
        itemsIndexed(paragraphs) { index, paragraph ->
            val current = paragraph.fragments.any { it.passage.id == active?.id }
            Text(paragraph.text, fontFamily = FontFamily.Serif, fontSize = size.sp, letterSpacing = 0.sp, lineHeight = (size * 1.7).sp, onTextLayout = { if (layouts[index]?.layoutInput != it.layoutInput) layouts[index] = it }, modifier = Modifier.widthIn(max = maxMeasure).fillMaxWidth().background(if (current) mint else androidx.compose.ui.graphics.Color.Transparent, androidx.compose.foundation.shape.RoundedCornerShape(7.dp)).drawBehind { if (current) drawLine(teal, Offset(0f, 0f), Offset(0f, this.size.height), strokeWidth = 2.dp.toPx()) }.padding(horizontal = 12.dp, vertical = 8.dp).pointerInput(paragraph) {
                detectTapGestures { point -> layouts[index]?.getOffsetForPosition(point)?.let { offset -> paragraph.fragments.firstOrNull { offset >= it.start && offset < it.end }?.let { tap(it.passage.start) } } }
            }.semantics {
                selected = paragraph.fragments.any { it.passage.id == active?.id }
                onClick(label = "Listen from this paragraph") { paragraph.fragments.firstOrNull()?.let { tap(it.passage.start) }; true }
                customActions = paragraph.fragments.distinctBy { it.passage.id }.map { fragment -> CustomAccessibilityAction("Listen from ${formatTime(fragment.passage.start)}") { tap(fragment.passage.start); true } }
            })
        }
        if (previous != null || next != null) item { Row(Modifier.widthIn(max = maxMeasure).fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { if (previous != null) TextButton(onClick = previous) { Text("Previous chapter") } else Spacer(Modifier.width(1.dp)); if (next != null) TextButton(onClick = next) { Text("Next chapter") } } }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ListeningSettings(state: ListenerUiState, size: Float, changeSize: (Float) -> Unit, edition: (String) -> Unit, includeNotes: (Boolean) -> Unit, dismiss: () -> Unit) {
    val book = state.books.find { it.id == state.selection?.story }
    val accent = MaterialTheme.colorScheme.primary
    ListenerSheet("Listening settings", dismiss) {
        Text("Playback", fontSize = 12.8.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
        AuthorNoteSetting(state.includeAuthorNotes, includeNotes)
        HorizontalDivider(Modifier.padding(top = 8.dp, bottom = 16.dp))
        Text("Audio edition", fontSize = 12.8.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
        Text("Switch at the same passage.", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 6.dp, bottom = 8.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            book?.editions?.forEach { (name, chapters) ->
                val selected = state.selection?.edition == name
                TextButton(onClick = { edition(name) }, enabled = !state.switchingEdition && chapters.any { it.id == state.selection?.chapter?.id },
                    shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
                    colors = ButtonDefaults.textButtonColors(containerColor = if (selected) MaterialTheme.colorScheme.primaryContainer else androidx.compose.ui.graphics.Color.Transparent),
                    contentPadding = PaddingValues(horizontal = 12.dp), modifier = Modifier.drawBehind { if (selected) drawLine(accent, Offset(0f, this.size.height - 1.dp.toPx()), Offset(this.size.width, this.size.height - 1.dp.toPx()), 2.dp.toPx()) }.semantics { this.selected = selected }) { Text(editionName(name)) }
            }
        }
        if (state.switchingEdition) Text("Changing edition…", style = MaterialTheme.typography.bodySmall)
        if (state.editionError.isNotEmpty()) Text(state.editionError, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        HorizontalDivider(Modifier.padding(top = 16.dp, bottom = 16.dp))
        Text("Reading text size", fontSize = 12.8.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { changeSize((size - 2.496f).coerceIn(14.144f, 24.128f)) }, enabled = size > 14.144f, modifier = Modifier.semantics { contentDescription = "Decrease text size" }) { Text("A−") }
            Text("${kotlin.math.round(size / 16.64f * 100).toInt()}%", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = { changeSize((size + 2.496f).coerceIn(14.144f, 24.128f)) }, enabled = size < 24.128f, modifier = Modifier.semantics { contentDescription = "Increase text size" }) { Text("A+") }
        }
        Text("The light swept across the harbour as June opened the letter.", fontSize = size.sp, fontFamily = FontFamily.Serif, lineHeight = (size * 1.7).sp, letterSpacing = 0.sp, modifier = Modifier.padding(top = 12.dp))
    }
}
@Composable
fun AuthorNoteSetting(include: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(value = include, role = Role.Checkbox, onValueChange = onChange).testTag("include-author-notes"), verticalAlignment = Alignment.CenterVertically) {
        Text("Include author notes", style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
        Checkbox(include, null, modifier = Modifier.size(20.dp))
    }
}
internal fun speedLabel(value: Float): String = String.format(java.util.Locale.ROOT, "%.2f", value).trimEnd('0').let { if (it.endsWith('.')) it + "0" else it }
@Composable
internal fun SpeedSettings(current: Float, change: (Float) -> Unit, dismiss: () -> Unit) {
    var custom by remember { mutableStateOf(speedLabel(current)) }
    val customFocus = remember { androidx.compose.ui.focus.FocusRequester() }
    var error by remember { mutableStateOf(false) }
    val raw = custom.trim().replace(',', '.')
    val parsed = raw.takeIf { Regex("(?:\\d+(?:\\.\\d+)?|\\.\\d+)").matches(it) }?.toFloatOrNull()?.takeIf { it.isFinite() && it in .1f..4f }
    fun apply() { if (parsed == null) error = true else { change(parsed); dismiss() } }
    val presets = (8..25).map { val value = it / 10f; speedLabel(value) to "${speedLabel(value)}×" }
    val customActive = presets.none { kotlin.math.abs(it.first.toFloat() - current) < .00001f }
    ListenerSheet("Playback speed", dismiss) {
        Row(Modifier.fillMaxWidth().padding(bottom = 16.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { val value = (kotlin.math.round((current - .1f) * 10000) / 10000).coerceIn(.1f, 4f); change(value); custom = speedLabel(value); error = false }, enabled = current > .1f, contentPadding = PaddingValues(horizontal = 4.dp), modifier = Modifier.semantics { contentDescription = "Decrease speed by 0.1" }) { Text("−0.1") }
            Text("${speedLabel(current)}×", fontSize = 23.2.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
            TextButton(onClick = { val value = (kotlin.math.round((current + .1f) * 10000) / 10000).coerceIn(.1f, 4f); change(value); custom = speedLabel(value); error = false }, enabled = current < 4f, contentPadding = PaddingValues(horizontal = 4.dp), modifier = Modifier.semantics { contentDescription = "Increase speed by 0.1" }) { Text("+0.1") }
        }
        ChoiceField("Speed in 0.1× steps", if (customActive) "Custom · ${speedLabel(current)}×" else "${speedLabel(current)}×", presets + listOf("" to if (customActive) "Custom · ${speedLabel(current)}×" else "Custom"), if (customActive) "" else speedLabel(current)) { value -> if (value.isNotEmpty()) { change(value.toFloat()); dismiss() } else customFocus.requestFocus() }
        HorizontalDivider(Modifier.padding(top = 16.dp, bottom = 16.dp))
        Text("Custom speed", style = MaterialTheme.typography.labelLarge)
        Text("Enter 0.1 to 4.0, for example 1.35.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp, bottom = 8.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            CompactTextField(custom, { custom = it; error = false }, "Custom speed", error, modifier = Modifier.width(100.dp).weight(1f).focusRequester(customFocus),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = androidx.compose.ui.text.input.ImeAction.Done), keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { apply() }))
            Button(onClick = { apply() }, shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp), modifier = Modifier.heightIn(min = 48.dp), contentPadding = PaddingValues(horizontal = 12.dp)) { Text("Apply speed") }
        }
        if (error) Text("Enter a number from 0.1 to 4.0.", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
    }
}

@Composable
internal fun RecentJumps(state: ListenerUiState, dismiss: () -> Unit, restore: (JSONObject) -> Unit, earlier: () -> Unit) {
    val context = LocalContext.current
    val store = remember(context) { ListenerStore.get(context) }; val audio = remember(context) { OfflineAudio(context) }
    val initialVersion = remember { state.returnVersion }
    LaunchedEffect(state.returnVersion) { if (state.returnVersion != initialVersion) dismiss() }
    val story = state.selection?.story
    val rows = (state.localJumps + state.history).filter { it.optJSONObject("from")?.optString("story") == story }.sortedByDescending { it.optLong("deviceTime") }.distinctBy { entry -> val from = entry.getJSONObject("from"); from.optString("assembly") + from.optString("edition") + (from.optDouble("seconds") * 100).toLong() + ":" + entry.optLong("deviceTime") / 1000 }
    ListenerSheet("Recent jumps", dismiss) {
        SectionTitle(state.selection?.bookTitle.orEmpty())
        Text("Return to where you were before a jump.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp, bottom = 12.dp))
        if (state.offline) Text("Offline. Only downloaded recordings can be opened.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(bottom = 12.dp))
        if (state.returnError.isNotEmpty()) Text(state.returnError, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(bottom = 12.dp))
        if (state.returning) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (rows.isEmpty()) { SectionTitle("No jumps yet"); Text("When you jump to another passage, the place you left appears here.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 8.dp)) }
        rows.forEach { entry ->
            val point = entry.getJSONObject("from")
            val cached = store.reading(point.optString("assembly"))
            val snapshot = point.optJSONObject("selection")?.optJSONObject("chapter")
            val checksum = snapshot?.optString("checksum")?.takeIf { it.isNotEmpty() } ?: cached?.optString("checksum").orEmpty()
            val available = !state.offline || cached != null && audio.ready(Chapter("", 0, "", point.optString("assembly"), 0.0, checksum))
            TextButton(onClick = { restore(point) }, enabled = !state.returning && available, modifier = Modifier.fillMaxWidth(), shape = androidx.compose.foundation.shape.RoundedCornerShape(0.dp), contentPadding = PaddingValues(vertical = 14.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        val reason = when (entry.optString("reason")) { "seek" -> "Before skipping ahead"; "chapter" -> "Before a chapter jump"; "restore" -> "Before returning from history"; else -> "Before a passage jump" }
                        Text("$reason · ${java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT).format(java.util.Date(entry.optLong("deviceTime")))}", fontSize = 11.sp, lineHeight = 16.5.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Normal, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text("Chapter ${point.optInt("chapter", snapshot?.optInt("sequence") ?: 0)} · ${formatTime(point.optDouble("seconds"))}", fontSize = 14.4.sp, lineHeight = 20.16.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)
                        Text("${point.optString("chapterTitle", "Saved passage")} · ${editionName(point.optString("edition"))}", fontSize = 12.sp, lineHeight = 18.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Normal, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (point.optString("excerpt").isNotBlank()) Text(point.optString("excerpt"), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Serif, color = MaterialTheme.colorScheme.onSurface, fontSize = 13.44.sp, lineHeight = 21.5.sp, maxLines = 2, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                        if (!available) Text("Not downloaded", style = MaterialTheme.typography.labelSmall)
                        if (state.returning) Text("Opening…", style = MaterialTheme.typography.labelSmall)
                    }
                    Icon(Icons.AutoMirrored.Filled.Undo, "Return here", Modifier.size(18.dp))
                }
            }
            HorizontalDivider()
        }
        if (state.historyBefore != null) TextButton(onClick = earlier, enabled = !state.returning) { Text("Earlier jumps") }
    }
}

@Composable
internal fun MarkIssueSheet(draft: JSONObject, draftError: String, update: (JSONObject) -> Unit, dismiss: () -> Unit, discard: () -> Unit, save: (String, String) -> Boolean) {
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val kinds = listOf("voice" to "Wrong voice", "pronunciation" to "Pronunciation", "missing" to "Missing or repeated text", "delivery" to "Delivery or pacing", "other" to "Other")
    val kind = draft.optString("kind", "delivery").takeIf { candidate -> kinds.any { it.first == candidate } } ?: "delivery"
    ListenerSheet("Mark an issue", dismiss) {
        SectionTitle(draft.optString("bookTitle", draft.optJSONObject("selection")?.optString("bookTitle").orEmpty()))
        Text("Paused · Chapter ${draft.optInt("chapter", draft.optJSONObject("selection")?.optJSONObject("chapter")?.optInt("sequence") ?: 1)} · ${editionName(draft.optString("edition"))} · ${formatTime(draft.optDouble("seconds"))}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp, bottom = 12.dp))
        val teal = MaterialTheme.colorScheme.primary
        if (draft.optString("excerpt").isNotBlank()) Text(draft.optString("excerpt"), fontFamily = FontFamily.Serif, fontSize = 13.6.sp, lineHeight = 22.4.sp, maxLines = 3, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.fillMaxWidth().padding(bottom = 20.dp).drawBehind { drawLine(teal, Offset.Zero, Offset(0f, size.height), 2.dp.toPx()) }.padding(start = 12.dp))
        ChoiceField("Problem", kinds.find { it.first == kind }?.second ?: "Delivery or pacing", kinds, kind) { update(JSONObject(draft.toString()).put("kind", it)) }
        Text("Note (optional)", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 16.dp, bottom = 6.dp))
        OutlinedTextField(draft.optString("note"), { value -> if (value.length <= 2000) update(JSONObject(draft.toString()).put("note", value)) }, minLines = 3, maxLines = 6, shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp), colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = MaterialTheme.colorScheme.surfaceContainer, unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainer), textStyle = MaterialTheme.typography.bodyMedium, modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp).semantics { contentDescription = "Optional note" })
        if (draftError.isNotEmpty()) Text(draftError, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
        if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
        FlowRow(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = discard, enabled = !saving) { Text("Discard draft") }
            Button(onClick = { if (!saving) { saving = true; if (!save(kind, draft.optString("note"))) { saving = false; error = "Couldn’t save on this phone. Your draft is kept. Try again." } } }, enabled = !saving, shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp), modifier = Modifier.heightIn(min = 48.dp), contentPadding = PaddingValues(horizontal = 12.dp)) { Text("Save issue") }
        }
    }
}
