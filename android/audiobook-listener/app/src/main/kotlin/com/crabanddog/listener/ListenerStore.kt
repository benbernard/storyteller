package com.crabanddog.listener

import android.content.Context
import android.content.ContentValues
import android.content.SharedPreferences
import android.database.sqlite.SQLiteOpenHelper
import android.database.sqlite.SQLiteDatabase
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Progress is durable locally before it enters the retryable server outbox. */
class ListenerStore private constructor(private val context: Context) {
    companion object {
        @Volatile private var instance: ListenerStore? = null
        fun get(context: Context): ListenerStore = instance ?: synchronized(this) { instance ?: ListenerStore(context.applicationContext).also { instance = it } }
    }
    private val prefs = context.getSharedPreferences("listening", Context.MODE_PRIVATE)
    private val database = object : SQLiteOpenHelper(context, "listening-events.db", null, 2) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL("CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, path TEXT NOT NULL, body TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0)")
            db.execSQL("CREATE TABLE readings (assembly TEXT PRIMARY KEY, body TEXT NOT NULL)")
            db.execSQL("CREATE TABLE issue_drafts (story TEXT PRIMARY KEY, body TEXT NOT NULL)")
        }
        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) { if (oldVersion < 2) db.execSQL("CREATE TABLE issue_drafts (story TEXT PRIMARY KEY, body TEXT NOT NULL)") }
    }.writableDatabase
    init {
        database.execSQL("CREATE INDEX IF NOT EXISTS events_pending ON events(acknowledged,sequence)")
        // A failed migration can safely replay the old outbox: event IDs are unique.
        val old = JSONArray(prefs.getString("outbox", "[]")!!)
        database.beginTransaction()
        try { for (i in 0 until old.length()) { val e = old.getJSONObject(i); enqueue(e.getString("path"), e.getJSONObject("body")) }; database.setTransactionSuccessful() }
        finally { database.endTransaction() }
        check(prefs.edit().remove("outbox").commit())
    }
    private fun enqueue(path: String, body: JSONObject) {
        val inserted = database.insertWithOnConflict("events", null, ContentValues().apply {
            put("event_id", body.getString("eventId")); put("path", path); put("body", body.toString())
        }, SQLiteDatabase.CONFLICT_IGNORE)
        if (inserted < 0) database.rawQuery("SELECT path,body FROM events WHERE event_id=?", arrayOf(body.getString("eventId"))).use { cursor ->
            check(cursor.moveToFirst() && cursor.getString(0) == path && cursor.getString(1) == body.toString()) { "Couldn’t store this event. Try again." }
        }
    }
    @Synchronized fun selection(): Selection? = runCatching { selectionFromJson(JSONObject(prefs.getString("selection", "")!!)) }.getOrNull()
    @Synchronized fun select(value: Selection) { check(prefs.edit().putString("selection", value.json().toString()).commit()) }
    @Synchronized fun position(value: Selection): Double {
        val p = JSONObject(prefs.getString("positions", "{}")!!).optJSONObject(value.key) ?: return 0.0
        return if (p.optString("assembly") == value.chapter.assembly) p.optDouble("seconds", 0.0) else 0.0
    }
    @Synchronized fun saveProgress(value: Selection, seconds: Double, completed: Boolean = false, reason: String = "pause", from: JSONObject? = null) {
        val entry = value.location(seconds).put("eventId", UUID.randomUUID().toString()).put("deviceTime", System.currentTimeMillis()).put("completed", completed).put("reason", if (completed) "complete" else reason)
        if (from != null) {
            entry.put("from", JSONObject().put("story", from.getString("story")).put("edition", from.getString("edition")).put("assembly", from.getString("assembly")).put("seconds", from.getDouble("seconds")))
            val old = from.optJSONObject("selection")?.let { runCatching { selectionFromJson(it) }.getOrNull() }
                ?: selection()?.takeIf { it.chapter.assembly == from.optString("assembly") }
                ?: library()?.let { data -> runCatching { booksFromJson(data) }.getOrNull() }?.find { it.id == from.optString("story") }?.let { book -> book.editions[from.optString("edition")]?.find { it.assembly == from.optString("assembly") }?.let { chapter -> Selection(book.id, book.title, from.getString("edition"), chapter) } }
            val reading = old?.let { reading(it.chapter.assembly)?.let(::readingFromJson) }
            entry.put("_localFrom", old?.let { describeLocalLocation(it, reading, from.getDouble("seconds")) } ?: from)
        }
        // Append first: acknowledged checkpoints remain in this permanent local log.
        enqueue("/progress", entry)
        val positions = JSONObject(prefs.getString("positions", "{}")!!).put(value.key, entry)
        val edit = prefs.edit().putString("positions", positions.toString())
        if (from != null && reason in listOf("seek", "passage", "chapter", "restore")) edit.putString("undo", from.toString())
        check(edit.commit())
    }
    @Synchronized fun issue(value: Selection, seconds: Double, kind: String, note: String) {
        val draft = draft(value.story)
        database.beginTransaction()
        try {
            enqueue("/issues", value.location(seconds).put("eventId", draft?.optString("eventId")?.takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString()).put("kind", kind).put("note", note).put("_localIssue", draft ?: describeLocalLocation(value, reading(value.chapter.assembly)?.let(::readingFromJson), seconds)))
            database.delete("issue_drafts", "story=?", arrayOf(value.story))
            database.setTransactionSuccessful()
        } finally { database.endTransaction() }
        notifyDrafts()
    }

    @Synchronized fun outbox(): List<JSONObject> = buildList {
        database.rawQuery("SELECT path,body FROM events WHERE acknowledged=0 ORDER BY sequence LIMIT 200", null).use { cursor ->
            while (cursor.moveToNext()) add(JSONObject().put("path", cursor.getString(0)).put("body", JSONObject(cursor.getString(1))))
        }
    }
    @Synchronized fun acknowledged(eventId: String) { database.execSQL("UPDATE events SET acknowledged=1 WHERE event_id=?", arrayOf(eventId)) }
    @Synchronized fun undo(): JSONObject? = prefs.getString("undo", null)?.let { JSONObject(it) }
    @Synchronized fun reading(assembly: String): JSONObject? = database.rawQuery("SELECT body FROM readings WHERE assembly=?", arrayOf(assembly)).use { if (it.moveToFirst()) JSONObject(it.getString(0)) else null }
    @Synchronized fun reading(assembly: String, body: JSONObject) { database.insertWithOnConflict("readings", null, ContentValues().apply { put("assembly", assembly); put("body", body.toString()) }, SQLiteDatabase.CONFLICT_REPLACE) }
    @Synchronized fun positions(): List<JSONObject> {
        val saved = JSONObject(prefs.getString("positions", "{}")!!)
        return saved.keys().asSequence().map { saved.getJSONObject(it) }.toList()
    }
    @Synchronized fun latestLocation(): JSONObject? {
        val positions = JSONObject(prefs.getString("positions", "{}")!!)
        return positions.keys().asSequence().map { positions.getJSONObject(it) }.maxByOrNull { it.optLong("deviceTime") }
    }
    @Synchronized fun latest(books: List<Book>): Selection? {
        val positions = JSONObject(prefs.getString("positions", "{}")!!)
        return positions.keys().asSequence().map { positions.getJSONObject(it) }.sortedByDescending { it.optLong("deviceTime") }.mapNotNull { p ->
            val book = books.find { it.id == p.optString("story") } ?: return@mapNotNull null
            val chapter = book.editions[p.optString("edition")]?.find { it.assembly == p.optString("assembly") } ?: return@mapNotNull null
            Selection(book.id, book.title, p.getString("edition"), chapter)
        }.firstOrNull()
    }
    @Synchronized fun importProgress(remote: JSONObject) {
        val positions = JSONObject(prefs.getString("positions", "{}")!!)
        remote.keys().forEach { key -> val incoming = remote.getJSONObject(key); if (incoming.optLong("deviceTime") > (positions.optJSONObject(key)?.optLong("deviceTime") ?: 0)) positions.put(key, incoming) }
        check(prefs.edit().putString("positions", positions.toString()).commit())
    }
    fun catalog(): JSONObject? = prefs.getString("catalog", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
    fun catalog(value: JSONObject) { prefs.edit().putString("catalog", value.toString()).putLong("catalog-reported-at", System.currentTimeMillis()).apply() }
    fun catalogReportedAt(): Long = prefs.getLong("catalog-reported-at", 0)
    fun speed(): Float = prefs.getFloat("speed", 1f)
    fun speed(value: Float) { prefs.edit().putFloat("speed", value).apply() }
    fun includeAuthorNotes(): Boolean = prefs.getBoolean("include-author-notes", true)
    fun includeAuthorNotes(value: Boolean) { prefs.edit().putBoolean("include-author-notes", value).apply() }
    fun observeSettings(listener: SharedPreferences.OnSharedPreferenceChangeListener) { prefs.registerOnSharedPreferenceChangeListener(listener) }
    fun stopObservingSettings(listener: SharedPreferences.OnSharedPreferenceChangeListener) { prefs.unregisterOnSharedPreferenceChangeListener(listener) }
    fun library(): JSONObject? = runCatching { JSONObject(prefs.getString("library", "")!!) }.getOrNull()
    fun library(value: JSONObject) { prefs.edit().putString("library", value.toString()).apply() }
    @Synchronized fun drafts(): List<JSONObject> = buildList {
        database.rawQuery("SELECT body FROM issue_drafts ORDER BY story", null).use { cursor -> while (cursor.moveToNext()) add(JSONObject(cursor.getString(0))) }
    }
    @Synchronized fun pendingIssues(): List<JSONObject> = buildList {
        database.rawQuery("SELECT body FROM events WHERE acknowledged=0 AND path='/issues' ORDER BY sequence DESC", null).use { cursor -> while (cursor.moveToNext()) { val body = JSONObject(cursor.getString(0)); body.put("id", body.getString("eventId")).put("status", "pending"); body.optJSONObject("_localIssue")?.let { location -> body.put("sequence", location.optInt("chapter")).put("excerpt", location.optString("excerpt")) }; add(body) } }
    }
    fun cachedHistory(): List<JSONObject> = jsonObjects(JSONArray(prefs.getString("history-cache", "[]")!!))
    fun cachedHistory(value: List<JSONObject>) { prefs.edit().putString("history-cache", JSONArray(value).toString()).apply() }
    @Synchronized fun hasPending(): Boolean = database.rawQuery("SELECT 1 FROM events WHERE acknowledged=0 LIMIT 1", null).use { it.moveToFirst() }
    fun textSize(): Float = prefs.getFloat("text-size", 16.64f).coerceIn(12f, 28f)
    fun textSize(value: Float) { prefs.edit().putFloat("text-size", value.coerceIn(12f, 28f)).apply() }
    @Synchronized fun draft(story: String): JSONObject? = database.rawQuery("SELECT body FROM issue_drafts WHERE story=?", arrayOf(story)).use { if (it.moveToFirst()) JSONObject(it.getString(0)) else null }
    @Synchronized fun hasDrafts(): Boolean = database.rawQuery("SELECT 1 FROM issue_drafts LIMIT 1", null).use { it.moveToFirst() }
    private fun notifyDrafts() { prefs.edit().putLong("draft-revision", System.nanoTime()).apply() }
    @Synchronized fun draft(story: String, value: JSONObject?) {
        if (value == null) database.delete("issue_drafts", "story=?", arrayOf(story))
        else database.execSQL("INSERT OR REPLACE INTO issue_drafts(story,body) VALUES(?,?)", arrayOf(story, value.toString()))
        notifyDrafts()
    }
    @Synchronized fun recentJumps(story: String, limit: Int = 40): List<JSONObject> = buildList {
        database.rawQuery("SELECT body FROM events WHERE path='/progress' ORDER BY sequence DESC", null).use { cursor ->
            val seen = mutableSetOf<String>()
            while (size < limit && cursor.moveToNext()) {
                val event = JSONObject(cursor.getString(0)); val from = event.optJSONObject("_localFrom") ?: event.optJSONObject("from") ?: continue
                if (from.optString("story") != story || event.optString("reason") !in listOf("seek", "passage", "chapter", "restore")) continue
                val key = from.optString("assembly") + ":" + from.optString("edition") + ":" + (from.optDouble("seconds") * 100).toLong()
                if (seen.add(key)) add(JSONObject().put("eventId", event.optString("eventId")).put("deviceTime", event.optLong("deviceTime")).put("from", from))
            }
        }
    }
    @Synchronized fun clear() { database.delete("events", null, null); database.delete("readings", null, null); database.delete("issue_drafts", null, null); check(prefs.edit().clear().commit()); java.io.File(context.filesDir, "listener-covers").deleteRecursively() }
}
