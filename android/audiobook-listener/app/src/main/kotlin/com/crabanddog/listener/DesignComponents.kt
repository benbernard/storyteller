package com.crabanddog.listener

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider

/** Artwork injection keeps preview/test fixtures out of the application network. */
internal val LocalStoryCovers = staticCompositionLocalOf<Map<String, ImageBitmap>> { emptyMap() }

@Composable
internal fun ListenerSheet(title: String, dismiss: () -> Unit, showClose: Boolean = true, content: @Composable ColumnScope.() -> Unit) {
    Dialog(onDismissRequest = dismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val window = (LocalView.current.parent as? DialogWindowProvider)?.window
        SideEffect { window?.setDimAmount(0f) }
        BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Box(Modifier.fillMaxSize().background(Color(0xff163a39).copy(alpha = .5f)).pointerInput(dismiss) { detectTapGestures { dismiss() } })
            Surface(
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 24.dp).widthIn(max = 360.dp).fillMaxWidth()
                    .heightIn(max = maxHeight - 48.dp).testTag("listener-sheet").pointerInput(Unit) { detectTapGestures {} },
                shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant), shadowElevation = 12.dp,
            ) {
                Column {
                    FlowRow(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 4.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalArrangement = Arrangement.spacedBy(8.dp), maxItemsInEachRow = if (androidx.compose.ui.platform.LocalDensity.current.fontScale >= 1.5f) 1 else Int.MAX_VALUE) {
                        Text(title, style = MaterialTheme.typography.titleMedium, letterSpacing = (-.336).sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.align(Alignment.CenterVertically).padding(end = 8.dp))
                        if (showClose) TextButton(onClick = dismiss, modifier = Modifier.align(Alignment.CenterVertically), contentPadding = PaddingValues(horizontal = 4.dp)) { Text("Close", style = MaterialTheme.typography.labelMedium) }
                    }
                    Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 20.dp), content = content)
                }
            }
        }
    }
}

@Composable
internal fun ChoiceField(label: String, value: String, choices: List<Pair<String, String>>, selected: String, enabled: Boolean = true, choose: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Text(label, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(bottom = 6.dp))
    Box {
        OutlinedButton(onClick = { expanded = true }, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = label },
            colors = ButtonDefaults.outlinedButtonColors(containerColor = MaterialTheme.colorScheme.surfaceContainer), shape = RoundedCornerShape(8.dp), border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant), contentPadding = PaddingValues(horizontal = 10.dp)) {
            Text(value, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
            Icon(Icons.Default.ExpandMore, null, modifier = Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, modifier = Modifier.heightIn(max = 320.dp)) {
            choices.forEach { (id, text) -> DropdownMenuItem(text = { Text(text, fontWeight = if (id == selected) FontWeight.SemiBold else FontWeight.Normal) }, onClick = { choose(id); expanded = false }) }
        }
    }
}

@Composable
internal fun SectionTitle(text: String, modifier: Modifier = Modifier) { Text(text, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = modifier) }

@Composable
internal fun BookIdentity(story: String, title: String, subtitle: String) {
    Row(Modifier.fillMaxWidth().testTag("book-identity").padding(top = 6.dp, bottom = 22.dp), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
        StoryCover(story, Modifier.size(48.dp, 72.dp))
        Column(Modifier.weight(1f)) { Text(title, style = MaterialTheme.typography.titleLarge, fontSize = 17.92.sp, fontWeight = FontWeight.SemiBold); Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp)) }
    }
}

@Composable
internal fun FactRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f), textAlign = androidx.compose.ui.text.style.TextAlign.End)
    }
    HorizontalDivider()
}

@Composable
internal fun FilterTabs(options: List<String>, selected: String, choose: (String) -> Unit) {
    val accent = MaterialTheme.colorScheme.primary
    Row(Modifier.fillMaxWidth().padding(top = 4.dp).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        options.forEach { label ->
            var textWidth by remember(label) { mutableIntStateOf(0) }
            Box(Modifier.widthIn(min = 48.dp).heightIn(min = 48.dp)
                .drawBehind { if (selected == label) drawLine(accent, Offset(0f, size.height - 1.dp.toPx()), Offset(textWidth + 4.dp.toPx(), size.height - 1.dp.toPx()), strokeWidth = 2.dp.toPx()) }
                .clickable(role = androidx.compose.ui.semantics.Role.Tab) { choose(label) }
                .semantics { this.selected = selected == label }.padding(horizontal = 2.dp), contentAlignment = Alignment.CenterStart) {
                Text(label, style = MaterialTheme.typography.labelMedium, color = if (selected == label) accent else MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = if (selected == label) FontWeight.SemiBold else FontWeight.Normal, onTextLayout = { textWidth = it.size.width })
            }
        }
    }
}

@Composable
internal fun SearchField(value: String, change: (String) -> Unit, label: String, hint: String, keyboardActions: androidx.compose.foundation.text.KeyboardActions = androidx.compose.foundation.text.KeyboardActions.Default, showIcon: Boolean = true) {
    Surface(shape = RoundedCornerShape(10.dp), border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant), color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
        androidx.compose.foundation.text.BasicTextField(value, change, singleLine = true, textStyle = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurface),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary), keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Search), keyboardActions = keyboardActions,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = label },
            decorationBox = { field -> Row(Modifier.padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (showIcon) Icon(Icons.Default.Search, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Box(Modifier.weight(1f).padding(vertical = 10.dp)) { if (value.isEmpty()) Text(hint, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant); field() }
                if (value.isNotEmpty()) TextButton(onClick = { change("") }, contentPadding = PaddingValues(horizontal = 8.dp), modifier = Modifier.semantics { contentDescription = "Clear search" }) { Text("Clear", fontSize = 11.52.sp) } else Spacer(Modifier.width(12.dp))
            } })
    }
}

@Composable
internal fun CompactTextField(value: String, change: (String) -> Unit, label: String, invalid: Boolean, modifier: Modifier = Modifier,
    keyboardOptions: androidx.compose.foundation.text.KeyboardOptions, keyboardActions: androidx.compose.foundation.text.KeyboardActions) {
    var focused by remember { mutableStateOf(false) }
    Surface(modifier, color = MaterialTheme.colorScheme.surfaceContainer, shape = RoundedCornerShape(8.dp),
        border = BorderStroke(if (focused) 2.dp else 1.dp, if (invalid) MaterialTheme.colorScheme.error else if (focused) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant)) {
        androidx.compose.foundation.text.BasicTextField(value, change, singleLine = true, keyboardOptions = keyboardOptions, keyboardActions = keyboardActions,
            textStyle = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurface), cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
            modifier = Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused }.semantics { contentDescription = label; if (invalid) error("Enter a number from 0.1 to 4.0.") },
            decorationBox = { field -> Box(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 10.dp, vertical = 10.dp), contentAlignment = Alignment.CenterStart) { field() } })
    }
}

@Composable
internal fun DesignProgress(progress: Float, modifier: Modifier = Modifier) {
    val accent = MaterialTheme.colorScheme.primary
    val track = MaterialTheme.colorScheme.outlineVariant
    androidx.compose.foundation.Canvas(modifier.height(5.dp).semantics { progressBarRangeInfo = androidx.compose.ui.semantics.ProgressBarRangeInfo(progress, 0f..1f) }) {
        drawRoundRect(track, cornerRadius = androidx.compose.ui.geometry.CornerRadius(size.height / 2))
        if (progress > 0) drawRoundRect(accent, size = androidx.compose.ui.geometry.Size(size.width * progress, size.height), cornerRadius = androidx.compose.ui.geometry.CornerRadius(size.height / 2))
    }
}
