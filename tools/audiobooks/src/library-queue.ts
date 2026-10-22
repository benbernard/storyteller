import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { bookOrbitId, bookOrbitUrl } from './integrations.js';
import type { AudioSelection, BookOrbitSource } from './bookorbit-selection.js';

export function royalRoadUrl(value: string) {
  const url = new URL(value);
  const match = /^\/fiction\/(\d+)(?:\/[^/]*)?\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'www.royalroad.com' || url.port || url.username || url.password || !match) throw new Error('bad_request');
  return { story: `rr-${match[1]}`, url: `https://www.royalroad.com/fiction/${match[1]}` };
}
export const followSchema = z.object({ url: z.string().max(1000), enabled: z.boolean(), mode: z.enum(['buffer', 'all', 'download']), buffer: z.number().int().min(1).max(20).default(5), intervalHours: z.number().int().min(1).max(168).default(6) }).strict();
export type Follow = z.infer<typeof followSchema> & { story: string; owner: string; nextCheck: number; updatedAt: string; bookorbit?: BookOrbitSource; listenerSelected?: boolean };
export type LibraryJob = { id: string; owner: string; story: string; url: string; mode: Follow['mode']; buffer: number;
  status: 'queued' | 'running' | 'waiting' | 'failed' | 'cancelled' | 'complete'; phase: string; createdAt: string; updatedAt: string;
  repair?: { reason: string; originals: Record<string, string> }; attempts: number; nextRun: number; cancel: boolean; error?: string; chapters?: string[]; completedChapters?: number; currentChapter?: string; batch?: string; bookorbit?: BookOrbitSource };
const now = () => new Date().toISOString();
/** Shared between the private worker and listener. SQLite arbitrates both processes. */
export class LibraryQueue {
  private db: DatabaseSync;
  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 }); const path = join(root, 'library-queue.sqlite');
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS follows (owner TEXT NOT NULL, story TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(owner,story));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, story TEXT NOT NULL, status TEXT NOT NULL, next_run INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_next ON jobs(status,next_run);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_story ON jobs(owner,story) WHERE status IN ('queued','running','waiting');
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), holder TEXT NOT NULL, expires INTEGER NOT NULL);`);
  }
  private transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  follows(owner?: string): Follow[] {
    const rows = owner ? this.db.prepare('SELECT body FROM follows WHERE owner=?').all(owner) : this.db.prepare('SELECT body FROM follows').all();
    return (rows as { body: string }[]).map(r => JSON.parse(r.body) as Follow);
  }
  private saveFollow(follow: Follow) { this.db.prepare('INSERT INTO follows(owner,story,body) VALUES(?,?,?) ON CONFLICT(owner,story) DO UPDATE SET body=excluded.body').run(follow.owner, follow.story, JSON.stringify(follow)); }
  follow(owner: string, input: z.infer<typeof followSchema>) {
    const book = bookOrbitId(input.url);
    const known = book && this.follows(owner).find(f => f.bookorbit?.bookId === book);
    const identity = book ? { story: known ? known.story : `bo-${book}`, url: known ? known.url : input.url } : royalRoadUrl(input.url);
    if (book && !this.follows(owner).some(f => f.story === identity.story && f.bookorbit?.files.length)) throw new Error('bad_request');
    return this.transaction(() => {
      const previous = this.follows(owner).find(f => f.story === identity.story);
      const follow: Follow = { ...previous, ...input, ...identity, owner, nextCheck: Date.now() + input.intervalHours * 3600000, updatedAt: now() }; this.saveFollow(follow);
      if (follow.enabled) {
        const active = this.active(owner, follow.story);
        if (active && active.mode !== follow.mode) this.cancelStory(owner, follow.story);
        const job = this.enqueue(follow);
        if (job.cancel || job.mode !== follow.mode) { follow.nextCheck = Date.now(); this.saveFollow(follow); }
      } // Disabling periodic checks does not cancel an explicitly running job.
      return follow;
    });
  }
  private cancelStory(owner: string, story: string) {
    const job = this.active(owner, story);
    if (job) { job.cancel = true; if (job.status !== 'running') job.status = 'cancelled'; this.write(job); }
  }
  /** An explicit Listener choice takes precedence over the optional BookOrbit tag. */
  audio(owner: string, selection: AudioSelection, enabled: boolean) {
    if (!selection.supported) throw new Error('bad_request');
    return this.transaction(() => {
      const old = this.follows(owner).find(f => f.story === selection.story);
      const follow: Follow = { mode: old?.mode === 'buffer' ? 'buffer' : 'all', buffer: old?.buffer ?? 5, intervalHours: old?.intervalHours ?? 6,
        url: selection.story.startsWith('rr-') ? `https://www.royalroad.com/fiction/${selection.story.slice(3)}` : bookOrbitUrl(selection.source.bookId),
        story: selection.story, owner, enabled, listenerSelected: enabled, bookorbit: selection.source, nextCheck: Date.now(), updatedAt: now() };
      this.saveFollow(follow);
      const active = this.active(owner, selection.story);
      if (active && active.mode !== follow.mode) this.cancelStory(owner, selection.story);
      if (enabled) this.enqueue(follow); else this.cancelStory(owner, selection.story);
      return follow;
    });
  }
  jobs(owner?: string): LibraryJob[] {
    const rows = owner ? this.db.prepare('SELECT body FROM jobs WHERE owner=? ORDER BY rowid DESC LIMIT 100').all(owner) : this.db.prepare("SELECT body FROM jobs WHERE status IN ('queued','running','waiting') ORDER BY rowid").all();
    return (rows as { body: string }[]).map(r => JSON.parse(r.body) as LibraryJob);
  }
  get(id: string): LibraryJob | undefined { const row = this.db.prepare('SELECT body FROM jobs WHERE id=?').get(id) as { body: string } | undefined; return row && JSON.parse(row.body) as LibraryJob; }
  private active(owner: string, story: string) {
    const row = this.db.prepare("SELECT body FROM jobs WHERE owner=? AND story=? AND status IN ('queued','running','waiting')").get(owner, story) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as LibraryJob : undefined;
  }
  private enqueue(follow: Follow) {
    const existing = this.active(follow.owner, follow.story); if (existing) return existing;
    const job: LibraryJob = { id: randomUUID(), owner: follow.owner, story: follow.story, url: follow.url, mode: follow.mode, buffer: follow.buffer,
      ...(follow.bookorbit ? { bookorbit: follow.bookorbit } : {}), status: 'queued', phase: follow.bookorbit ? 'Waiting to check BookOrbit' : 'Waiting to check Royal Road', createdAt: now(), updatedAt: now(), attempts: 0, nextRun: Date.now(), cancel: false };
    this.write(job); return job;
  }
  check(owner: string, story: string) {
    return this.transaction(() => { const follow = this.follows(owner).find(f => f.story === story); if (!follow || (follow.bookorbit && !follow.bookorbit.files.length)) throw new Error('not_found'); return this.enqueue(follow); });
  }
  repair(owner: string, story: string, originals: Record<string, string>, reason: string) {
    return this.transaction(() => {
      if (!reason.trim() || !Object.keys(originals).length) throw new Error('Repair needs chapters and reason');
      if (this.active(owner, story)) throw new Error('Story already has active work');
      const follow = this.follows(owner).find(f => f.story === story) ?? { owner, story, url: `https://www.royalroad.com/fiction/${story.replace(/^rr-/, '')}`, enabled: false, mode: 'all' as const, buffer: 5, intervalHours: 6, nextCheck: 0, updatedAt: now() };
      const job = this.enqueue(follow); job.repair = { reason, originals }; job.chapters = Object.keys(originals); job.mode = 'all';
      job.phase = 'Waiting to repair published audio'; this.write(job); return job;
    });
  }
  action(owner: string, id: string, action: 'cancel' | 'retry') {
    return this.transaction(() => {
      const job = this.get(id); if (!job || job.owner !== owner) throw new Error('not_found');
      if (action === 'cancel') { job.cancel = true; if (job.status !== 'running') job.status = 'cancelled'; }
      else {
        if (job.bookorbit && !this.follows(owner).find(f => f.story === job.story)?.bookorbit?.files.length) throw new Error('bad_request');
        if (!['failed', 'cancelled', 'waiting'].includes(job.status)) throw new Error('bad_request');
        const active = this.active(owner, job.story); if (active && active.id !== id) throw new Error('bad_request');
        job.status = 'queued'; job.cancel = false; job.attempts = 0; job.nextRun = Date.now(); delete job.error;
      }
      this.write(job); return job;
    });
  }
  schedule(at = Date.now()) { this.transaction(() => { for (const follow of this.follows()) if (follow.enabled && follow.nextCheck <= at) { const job = this.enqueue(follow); if (!job.cancel && job.mode === follow.mode) { follow.nextCheck = at + follow.intervalHours * 3600000; this.saveFollow(follow); } } }); }
  syncBookOrbit(owner: string, selections: AudioSelection[]) {
    this.transaction(() => {
      const prior = this.follows(owner);
      for (const follow of prior) if (follow.bookorbit && !selections.some(s => s.story === follow.story && s.supported && (s.source.selected !== false || follow.listenerSelected === true))) {
        follow.enabled = false; this.saveFollow(follow);
        this.cancelStory(owner, follow.story);
        follow.bookorbit.files = []; this.saveFollow(follow);
      }
      for (const selection of selections.filter(s => s.supported)) {
        const old = prior.find(f => f.story === selection.story);
        if (selection.source.selected === false && old?.listenerSelected === undefined) continue;
        const follow: Follow = { url: selection.story.startsWith('rr-') ? `https://www.royalroad.com/fiction/${selection.story.slice(3)}` : bookOrbitUrl(selection.source.bookId),
          mode: old?.mode ?? 'all', buffer: old?.buffer ?? 5, intervalHours: old?.intervalHours ?? 6,
          story: selection.story, owner, enabled: old?.bookorbit ? old.enabled : true,
          ...(old?.listenerSelected !== undefined ? { listenerSelected: old.listenerSelected } : {}),
          nextCheck: old?.nextCheck ?? Date.now(), updatedAt: now(), bookorbit: selection.source };
        // A tag removed and added again explicitly enables its generation.
        if (old?.bookorbit && !old.enabled && !old.bookorbit.files.length && old.listenerSelected !== false) follow.enabled = true;
        this.saveFollow(follow);
        const active = this.active(owner, follow.story);
        if (active && !active.bookorbit) { active.bookorbit = selection.source; this.write(active); }
      }
      // Remember removal separately from a listener pause.
      for (const follow of this.follows(owner)) if (follow.bookorbit && !selections.some(s => s.story === follow.story)) { follow.bookorbit.files = []; this.saveFollow(follow); }
    });
  }
  /** The single GPU worker's lease also prevents duplicate workers after deployment. */
  lease(holder: string, at = Date.now()): boolean {
    return this.transaction(() => {
      const old = this.db.prepare('SELECT holder,expires FROM lease WHERE id=1').get() as { holder: string; expires: number } | undefined;
      if (old && old.holder !== holder && old.expires > at) return false;
      if (!old || old.holder !== holder) for (const job of this.jobs()) if (job.status === 'running') { job.status = job.cancel ? 'cancelled' : 'queued'; this.write(job); }
      this.db.prepare('INSERT INTO lease(id,holder,expires) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET holder=excluded.holder,expires=excluded.expires').run(holder, at + 120000);
      return true;
    });
  }
  claim(holder: string): LibraryJob | undefined {
    return this.transaction(() => {
      const lease = this.db.prepare('SELECT holder,expires FROM lease WHERE id=1').get() as { holder: string; expires: number } | undefined;
      if (!lease || lease.holder !== holder || lease.expires < Date.now()) return;
      const job = this.jobs().find(j => ['queued', 'waiting'].includes(j.status) && j.nextRun <= Date.now() && !j.cancel);
      if (job) { job.status = 'running'; this.write(job); } return job;
    });
  }
  update(job: LibraryJob) {
    // Preserve a cancellation arriving from the listener during a long operation.
    return this.transaction(() => { if (this.get(job.id)?.cancel) job.cancel = true; this.write(job); return job; });
  }
  private write(job: LibraryJob) { job.updatedAt = now(); this.db.prepare('INSERT INTO jobs(id,owner,story,status,next_run,body) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,next_run=excluded.next_run,body=excluded.body').run(job.id, job.owner, job.story, job.status, job.nextRun, JSON.stringify(job)); }
  release(holder: string) { this.db.prepare('DELETE FROM lease WHERE holder=?').run(holder); }
  close() { this.db.close(); }
}
