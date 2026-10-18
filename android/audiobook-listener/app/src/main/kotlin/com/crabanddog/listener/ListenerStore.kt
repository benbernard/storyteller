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
class ListenerStore private constructor(context: Context) {
    companion object {
        @Volatile private var instance: ListenerStore? = null
        fun get(context: Context): ListenerStore = instance ?: synchronized(this) { instance ?: ListenerStore(context.applicationContext).also { instance = it } }
    }
    private val prefs = context.getSharedPreferences("listening", Context.MODE_PRIVATE)
    private val database = object : SQLiteOpenHelper(context, "listening-events.db", null, 1) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL("CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, path TEXT NOT NULL, body TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0)")
            db.execSQL("CREATE TABLE readings (assembly TEXT PRIMARY KEY, body TEXT NOT NULL)")
        }
        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
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
        database.insertWithOnConflict("events", null, ContentValues().apply {
            put("event_id", body.getString("eventId")); put("path", path); put("body", body.toString())
        }, SQLiteDatabase.CONFLICT_IGNORE)
    }
    @Synchronized fun selection(): Selection? = runCatching { selectionFromJson(JSONObject(prefs.getString("selection", "")!!)) }.getOrNull()
    @Synchronized fun select(value: Selection) { check(prefs.edit().putString("selection", value.json().toString()).commit()) }
    @Synchronized fun position(value: Selection): Double {
        val p = JSONObject(prefs.getString("positions", "{}")!!).optJSONObject(value.key) ?: return 0.0
        return if (p.optString("assembly") == value.chapter.assembly) p.optDouble("seconds", 0.0) else 0.0
    }
    @Synchronized fun saveProgress(value: Selection, seconds: Double, completed: Boolean = false, reason: String = "pause", from: JSONObject? = null) {
        val entry = value.location(seconds).put("eventId", UUID.randomUUID().toString()).put("deviceTime", System.currentTimeMillis()).put("completed", completed).put("reason", if (completed) "complete" else reason)
        if (from != null) entry.put("from", from)
        // Append first: acknowledged checkpoints remain in this permanent local log.
        enqueue("/progress", entry)
        val positions = JSONObject(prefs.getString("positions", "{}")!!).put(value.key, entry)
        val edit = prefs.edit().putString("positions", positions.toString())
        if (from != null && reason in listOf("seek", "passage", "chapter")) edit.putString("undo", from.toString())
        check(edit.commit())
    }
    @Synchronized fun issue(value: Selection, seconds: Double, kind: String, note: String) {
        enqueue("/issues", value.location(seconds).put("eventId", UUID.randomUUID().toString()).put("kind", kind).put("note", note))
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
    fun speed(): Float = prefs.getFloat("speed", 1f)
    fun speed(value: Float) { prefs.edit().putFloat("speed", value).apply() }
    fun includeAuthorNotes(): Boolean = prefs.getBoolean("include-author-notes", true)
    fun includeAuthorNotes(value: Boolean) { prefs.edit().putBoolean("include-author-notes", value).apply() }
    fun observeSettings(listener: SharedPreferences.OnSharedPreferenceChangeListener) { prefs.registerOnSharedPreferenceChangeListener(listener) }
    fun stopObservingSettings(listener: SharedPreferences.OnSharedPreferenceChangeListener) { prefs.unregisterOnSharedPreferenceChangeListener(listener) }
    fun library(): JSONObject? = runCatching { JSONObject(prefs.getString("library", "")!!) }.getOrNull()
    fun library(value: JSONObject) { prefs.edit().putString("library", value.toString()).apply() }
    @Synchronized fun clear() { database.delete("events", null, null); database.delete("readings", null, null); check(prefs.edit().clear().commit()) }
}
