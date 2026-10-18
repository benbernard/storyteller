package com.crabanddog.listener

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            ListenerTheme {
                val model: ListenerViewModel = viewModel()
                val state by model.state.collectAsStateWithLifecycle()
                val lifecycle = LocalLifecycleOwner.current.lifecycle
                LaunchedEffect(model, lifecycle) {
                    lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { while (true) { delay(5000); model.poll() } }
                }
                ListenerScreen(state, onConnect = { model.connect { url -> startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } },
                    onRefresh = model::refresh, onDisconnect = model::disconnect, onPlay = model::play, onToggle = model::toggle, onSeek = model::seek,
                    onSpeed = model::speed, onIssue = model::markIssue, onFinished = model::finished, onResolve = model::resolve, onCharacters = model::characters, onPassage = model::passage, onHistory = model::history, onReturn = model::returnTo, onFollow = model::follow, onCheck = model::check, onJob = model::job, onAudio = model::audio, onIncludeAuthorNotes = model::includeAuthorNotes)
            }
        }
    }
}

@androidx.compose.runtime.Composable
fun ListenerTheme(content: @androidx.compose.runtime.Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) darkColorScheme(
        primary = Color(0xff83d6c8), onPrimary = Color(0xff00382f), primaryContainer = Color(0xff155449), onPrimaryContainer = Color(0xffaff2e4),
        secondary = Color(0xffffb5a4), secondaryContainer = Color(0xff30483f), onSecondaryContainer = Color(0xffdef2df),
        background = Color(0xff151c19), surface = Color(0xff151c19), surfaceContainer = Color(0xff233029),
        onSurface = Color(0xffeee9de), onSurfaceVariant = Color(0xffbac9c0), outlineVariant = Color(0xff3c4b43)
    ) else lightColorScheme(
        primary = Color(0xff176759), onPrimary = Color.White, primaryContainer = Color(0xffbcebdd), onPrimaryContainer = Color(0xff063c31),
        secondary = Color(0xff9b4834), secondaryContainer = Color(0xffe3efdb), onSecondaryContainer = Color(0xff233d2d),
        background = Color(0xfffffbf2), surface = Color(0xfffffbf2), surfaceContainer = Color(0xffefeede),
        onSurface = Color(0xff24362e), onSurfaceVariant = Color(0xff59665d), outlineVariant = Color(0xffd4dbcd)
    )
    MaterialTheme(colorScheme = colors, content = content)
}
