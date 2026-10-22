import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprint } from './store.js';

export type ListeningLocation = { story: string; edition: string; assembly: string; chapterId: string; chapterTitle: string; chapter: number; seconds: number; duration: number;
  source: string; passage: string | null; passageIndex: number; offset: number; endOffset: number; spans: string[]; excerpt: string; storySeconds: number; storyDuration: number; chapterCount: number };
export type LocationEvent = { eventId: string; deviceTime: number; receivedAt: string; reason: string; location: ListeningLocation; from?: ListeningLocation };

/** Every accepted position event is retained. Paging never depends on the phone's clock. */
export class ListeningHistory {
  private db: DatabaseSync;
  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = join(root, 'locations.sqlite'); this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS locations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, event_id TEXT NOT NULL, story TEXT NOT NULL, identity TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(owner,event_id));
      CREATE INDEX IF NOT EXISTS locations_owner_story ON locations(owner,story,sequence DESC);`);
  }
  record(owner: string, event: LocationEvent, input: unknown) {
    const identity = fingerprint(input);
    const old = this.db.prepare('SELECT identity FROM locations WHERE owner=? AND event_id=?').get(owner, event.eventId) as { identity: string } | undefined;
    if (old) { if (old.identity !== identity) throw new Error('bad_request'); return; }
    this.db.prepare('INSERT INTO locations(owner,event_id,story,identity,body) VALUES(?,?,?,?,?)').run(owner, event.eventId, event.location.story, identity, JSON.stringify(event));
  }
  list(owner: string, story: string | undefined, before: number, limit = 50, jumpsOnly = false) {
    const condition = jumpsOnly ? " AND json_type(body,'$.from')='object' AND json_extract(body,'$.reason') IN ('seek','passage','chapter','restore')" : '';
    const storyColumn = jumpsOnly ? "json_extract(body,'$.from.story')" : 'story';
    const rows = story
      ? this.db.prepare(`SELECT sequence,body FROM locations WHERE owner=? AND ${storyColumn}=? AND sequence<?${condition} ORDER BY sequence DESC LIMIT ?`).all(owner, story, before, limit + 1)
      : this.db.prepare(`SELECT sequence,body FROM locations WHERE owner=? AND sequence<?${condition} ORDER BY sequence DESC LIMIT ?`).all(owner, before, limit + 1);
    const entries = (rows as { body: string; sequence: number }[]).slice(0, limit).map(r => ({ ...JSON.parse(String(r.body)) as LocationEvent, sequence: Number(r.sequence) }));
    return { entries, before: rows.length > limit ? entries.at(-1)!.sequence : null };
  }
  close() { this.db.close(); }
}
