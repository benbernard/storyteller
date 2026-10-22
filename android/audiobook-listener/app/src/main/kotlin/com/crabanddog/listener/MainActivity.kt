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
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Typography
import androidx.compose.material3.Shapes
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp
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
    private val signInReturn = androidx.compose.runtime.mutableStateOf<Uri?>(null)
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); signInReturn.value = intent.data }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        signInReturn.value = intent.data
        enableEdgeToEdge()
        setContent {
            ListenerTheme {
                val model: ListenerViewModel = viewModel()
                val state by model.state.collectAsStateWithLifecycle()
                LaunchedEffect(signInReturn.value) { signInReturn.value?.let { model.finishSignIn(it); signInReturn.value = null } }
                val lifecycle = LocalLifecycleOwner.current.lifecycle
                LaunchedEffect(model, lifecycle) {
                    lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { while (true) { delay(5000); model.poll() } }
                }
                ListenerScreen(state, onConnect = { model.connect { url -> startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } },
                    onRefresh = model::refresh, onDisconnect = model::disconnect, onPlay = model::play, onToggle = model::toggle, onSeek = model::seek,
                    onSpeed = model::speed, onIssue = model::markIssue, onFinished = model::finished, onResolve = model::resolve, onCharacters = model::characters, onPassage = model::passage, onHistory = model::history, onReturn = model::returnTo, onFollow = model::follow, onCheck = model::check, onJob = model::job, onAudio = model::audio, onIncludeAuthorNotes = model::includeAuthorNotes, onSkip = model::skip, onEdition = model::switchEdition, onCancelSignIn = model::cancelSignIn, onCancelReturn = model::cancelReturn, onPassageSelection = model::passageAt, onSaveIssue = model::saveIssue, onChapterPlay = model::playChapter)
            }
        }
    }
}

@androidx.compose.runtime.Composable
fun ListenerTheme(content: @androidx.compose.runtime.Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) darkColorScheme(
        primary = Color(0xffa4e2cd), onPrimary = Color(0xff163a34), primaryContainer = Color(0xff28483f), onPrimaryContainer = Color(0xffedf5ec),
        secondary = Color(0xffa4e2cd), secondaryContainer = Color(0xff28483f), onSecondaryContainer = Color(0xffedf5ec),
        background = Color(0xff182e31), surface = Color(0xff182e31), surfaceContainer = Color(0xff213b3e),
        surfaceContainerLow = Color(0xff182e31), surfaceContainerHigh = Color(0xff213b3e), surfaceContainerHighest = Color(0xff213b3e), surfaceVariant = Color(0xff213b3e),
        onBackground = Color(0xffedf5ec), onSurface = Color(0xffedf5ec), onSurfaceVariant = Color(0xffb7cdc5), outline = Color(0xff46615c), outlineVariant = Color(0xff46615c)
    ) else lightColorScheme(
        primary = Color(0xff176b65), onPrimary = Color.White, primaryContainer = Color(0xffe0f2e5), onPrimaryContainer = Color(0xff213e40),
        secondary = Color(0xff176b65), secondaryContainer = Color(0xffe0f2e5), onSecondaryContainer = Color(0xff213e40),
        background = Color(0xfffffdf7), surface = Color(0xfffffdf7), surfaceContainer = Color.White,
        surfaceContainerLow = Color(0xfffffdf7), surfaceContainerHigh = Color.White, surfaceContainerHighest = Color.White, surfaceVariant = Color.White,
        onBackground = Color(0xff213e40), onSurface = Color(0xff213e40), onSurfaceVariant = Color(0xff526764), outline = Color(0xffd4ded7), outlineVariant = Color(0xffd4ded7)
    )
    val typography = Typography(
        headlineSmall = TextStyle(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.SemiBold),
        titleLarge = TextStyle(fontSize = 20.sp, lineHeight = 25.sp, fontWeight = FontWeight.SemiBold),
        titleMedium = TextStyle(fontSize = 16.8.sp, lineHeight = 21.sp, fontWeight = FontWeight.SemiBold),
        titleSmall = TextStyle(fontSize = 14.08.sp, lineHeight = 18.3.sp, fontWeight = FontWeight.SemiBold),
        bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        bodyMedium = TextStyle(fontSize = 13.3.sp, lineHeight = 20.sp),
        bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 18.sp),
        labelLarge = TextStyle(fontSize = 13.12.sp, lineHeight = 18.sp, fontWeight = FontWeight.SemiBold),
        labelMedium = TextStyle(fontSize = 12.16.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
        labelSmall = TextStyle(fontSize = 10.72.sp, lineHeight = 16.sp),
    )
    MaterialTheme(colorScheme = colors, typography = typography, shapes = Shapes(small = RoundedCornerShape(8.dp), medium = RoundedCornerShape(10.dp), large = RoundedCornerShape(16.dp), extraLarge = RoundedCornerShape(16.dp))) { CompositionLocalProvider(LocalContentColor provides colors.onSurface, content = content) }
}
