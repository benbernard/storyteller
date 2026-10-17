package com.crabanddog.listener

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

fun repairChapterLabel(repair: JSONObject?, chapter: String): String? {
    val chapters = repair?.optJSONArray("chapters") ?: return null
    return (0 until chapters.length()).map { chapters.getJSONObject(it) }.find { it.optString("id") == chapter }?.optString("label")
}

@Composable
fun RepairStatusPanel(repair: JSONObject) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    OutlinedCard(Modifier.fillMaxWidth().testTag("repair-status")) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(repair.optString("title"), style = MaterialTheme.typography.titleLarge)
            Text(repair.optString("detail"), style = MaterialTheme.typography.bodyMedium)
            val total = repair.optInt("total")
            if (total > 0) {
                val completed = repair.optInt("completed")
                Text("$completed of $total chapters updated", style = MaterialTheme.typography.bodyMedium)
                LinearProgressIndicator(progress = { (completed.toFloat() / total).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Hide chapter repair queue" else "Chapter repair queue") }
                if (expanded) {
                    val chapters = repair.optJSONArray("chapters")
                    for (index in 0 until (chapters?.length() ?: 0)) {
                        val chapter = chapters!!.getJSONObject(index)
                        Text(chapter.optString("title"), style = MaterialTheme.typography.titleSmall)
                        Text(chapter.optString("label"), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        HorizontalDivider()
                    }
                }
            }
            val timestamp = runCatching { DateTimeFormatter.ofPattern("MMM d, h:mm a").withZone(ZoneId.systemDefault()).format(Instant.parse(repair.optString("updatedAt"))) }.getOrNull()
            if (timestamp != null) Text("Last activity: $timestamp", style = MaterialTheme.typography.bodySmall)
        }
    }
}
