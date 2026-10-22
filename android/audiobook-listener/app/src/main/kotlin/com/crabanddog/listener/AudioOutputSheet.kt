package com.crabanddog.listener

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BluetoothAudio
import androidx.compose.material.icons.filled.Speaker
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

@Composable
internal fun AudioOutputSheet(dismiss: () -> Unit) {
    val context = LocalContext.current
    val outputs = remember(context) { AudioOutputs.get(context) }
    val state by outputs.state.collectAsState()
    LaunchedEffect(outputs) { while (true) { outputs.refresh(); delay(500) } }
    var settingsError by remember { mutableStateOf(false) }
    OutputChoices(state, outputs::select, outputs::volume, {
        runCatching { context.startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS)) }.onFailure { settingsError = true }
    }, dismiss, settingsError)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun OutputChoices(state: AudioOutputState, select: (Int) -> Unit, volume: (Float) -> Unit, settings: () -> Unit, dismiss: () -> Unit, settingsError: Boolean = false) {
    ListenerSheet("Audio output", dismiss) {
        if (!state.available) Text("The audio player is starting. Try again in a moment.", style = MaterialTheme.typography.bodyMedium)
        state.devices.forEach { device ->
            val routed = device.id == state.routed
            val requested = device.id == state.requested && !routed
            Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).selectable(selected = routed, role = Role.RadioButton, onClick = { select(device.id) }).padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(if (device.bluetooth) Icons.Default.BluetoothAudio else Icons.Default.Speaker, null, modifier = Modifier.size(20.dp))
                Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                    Text(device.name, style = MaterialTheme.typography.bodyMedium)
                    if (routed || requested) Text(if (routed) "Current output" else if (state.error.isNotEmpty()) "Switch not confirmed" else if (state.playing) "Switching…" else "Selected · applies when audio resumes", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                RadioButton(routed, null)
            }
        }
        if (state.available) {
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            Text("Listener volume", style = MaterialTheme.typography.labelMedium)
            Slider(value = state.volume, onValueChange = volume, steps = 0,
                thumb = { Box(Modifier.size(12.dp).background(MaterialTheme.colorScheme.primary, CircleShape)) },
                track = { slider -> SliderDefaults.Track(sliderState = slider, modifier = Modifier.height(4.dp), thumbTrackGapSize = 0.dp, drawStopIndicator = null) },
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Listener volume" })
        }
        if (state.error.isNotEmpty()) Text(state.error, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        TextButton(onClick = settings, contentPadding = PaddingValues(horizontal = 0.dp)) { Text("Device settings") }
        if (settingsError) Text("Device settings could not open. Use your phone’s Bluetooth settings.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
    }
}
