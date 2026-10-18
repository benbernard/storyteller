import { ownerPermissions, bookOrbitUrl, type ListenerIntegrations } from './integrations.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Store, sha } from './store.js';
import { editionSchema, type Book, type BookChapter, type Edition } from './book.js';
import { id, type Analysis, type Assembly, type Cast, type Chapter } from './schema.js';
import type { SourceIndex } from './local-ingest.js';
import type { AudioSelection } from './bookorbit-selection.js';
import { LibraryQueue, followSchema } from './library-queue.js';
import { storyLibrary, archiveManifest, cover, publicJob } from './story-library.js';
import { repairStatus } from './repair-status.js';
import { reading, passageAt } from './reading.js';
import { ListeningHistory, type ListeningLocation } from './listening-history.js';
import {listenerIdentity, basicIdentity, type BrowserOwner} from './listener-identity.js';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const location = z.object({ story: id, edition: editionSchema, assembly: hex, seconds: z.number().finite().nonnegative() });
const progressSchema = location.extend({ eventId: z.uuid(), deviceTime: z.number().int().positive(), completed: z.boolean().default(false),
  reason: z.enum(['playing', 'pause', 'seek', 'passage', 'chapter', 'restore', 'complete']).default('playing'), from: location.strict().optional() }).strict();
const issueSchema = location.extend({ eventId: z.uuid(), kind: z.enum(['voice', 'pronunciation', 'missing', 'delivery', 'other']), note: z.string().max(2000) }).strict();
type Progress = z.infer<typeof progressSchema> & { sequence: number; chapterId: string; receivedAt: string };
type Issue = z.infer<typeof issueSchema> & { id: string; sequence: number; chapterId: string; source: string; segmentId: string; spans: string[]; status: 'open' | 'resolved'; createdAt: string };
type ListenerState = { positions: Record<string, Progress>; completed: Record<string, boolean>; seen: Record<string, { chapter: number; offset: number }>; issues: Issue[] };
type Pair = { code: string; secretHash: string; expires: number; owner?: string; tokenHash?: string };
type Device = { owner: string; name: string; createdAt: string; revoked?: boolean };
const empty = (): ListenerState => ({ positions: {}, completed: {}, seen: {}, issues: [] });
const json = (response: ServerResponse, status: number, data: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
async function body(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('bad_request');
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of request) { const bytes = Buffer.from(part); size += bytes.length; if (size > 16384) throw new Error('bad_request'); chunks.push(bytes); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('bad_request'); }
}

export function createListener(fictions: string, state: Store, browserOwner: BrowserOwner, origin = 'https://listener.example.org', archive = process.env.ROYAL_ROAD_ARCHIVE ?? '/archive', basicChallenge = false, integrations: ListenerIntegrations = {}) {
  const history = new ListeningHistory(state.root);
  const libraryQueue = new LibraryQueue(state.root);
  // All record mutations are serialized in the sole server process and atomically persisted.
  let queue: Promise<unknown> = Promise.resolve();
  const mutate = <T>(fn: () => Promise<T>): Promise<T> => { const next = queue.then(fn); queue = next.catch(() => undefined); return next; };
  const pairRate = new Map<string, { since: number; count: number }>();
  const getBook = async (story: string) => {
    id.parse(story); const store = new Store(join(fictions, story)); const book = await store.read<Book>('book.json');
    if (!book || book.id !== story) throw new Error('not_found'); return { store, book };
  };
  const getLocation = async (value: z.infer<typeof location>) => {
    const { store, book } = await getBook(value.story);
    const chapter = book.editions[value.edition]?.chapters.find(c => c.assembly === value.assembly);
    // Published historical assemblies remain addressable after a repair.
    let match: BookChapter | undefined = chapter;
    if (!match) for (const file of await store.list('book-history')) {
      const revision = await store.read<Book>(`book-history/${file}`);
      match = revision?.editions[value.edition]?.chapters.find(c => c.assembly === value.assembly); if (match) break;
    }
    if (!match) throw new Error('not_found');
    const assembly = await store.read<Assembly>(`assemblies/${value.assembly}/metadata.json`);
    if (!assembly || value.seconds > assembly.duration + 1) throw new Error('bad_request');
    return { store, book, chapter: match, assembly };
  };
  const describeLocation = async (value: z.infer<typeof location>): Promise<ListeningLocation> => {
    const { store, book, chapter, assembly } = await getLocation(value);
    const source = await store.read<Chapter>(`sources/${assembly.source}.json`);
    const segment = passageAt(assembly.timeline, value.seconds);
    const offset = segment?.spans[0]?.start ?? 0;
    const chapters = book.editions[value.edition]?.chapters ?? [];
    return { story: value.story, edition: value.edition, assembly: value.assembly, chapterId: chapter.id, chapterTitle: chapter.title, chapter: chapter.sequence, seconds: Math.min(value.seconds, assembly.duration), duration: assembly.duration,
      source: assembly.source, passage: segment?.segmentId ?? null, passageIndex: segment ? assembly.timeline.indexOf(segment) : 0, offset, endOffset: segment?.spans.at(-1)?.end ?? offset, spans: segment?.spans.map(s => s.uid) ?? [],
      excerpt: source?.text.slice(offset, Math.min(offset + 200, segment?.spans.at(-1)?.end ?? offset + 200)) ?? '',
      storySeconds: chapters.filter(c => c.sequence < chapter.sequence).reduce((n, c) => n + c.duration, 0) + Math.min(value.seconds, assembly.duration),
      storyDuration: chapters.reduce((n, c) => n + c.duration, 0), chapterCount: chapters.length };
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'private, no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(request.url ?? '/', origin), method = request.method ?? 'GET';
      if (url.pathname === '/') { response.writeHead(302, {Location: '/listen/'}); response.end(); return; }
      if (url.pathname === '/healthz') { json(response, 200, { ready: true }); return; }
      const web = url.pathname === '/listen' || url.pathname.startsWith('/listen/');
      const route = web ? url.pathname.slice('/listen'.length) : url.pathname.slice('/api/listener'.length);
      if (!web && !url.pathname.startsWith('/api/listener/')) throw new Error('not_found');
      let owner: string | undefined;
      if (web) {
        owner = browserOwner(request) ?? undefined;
        if (!owner) { if (basicChallenge) response.setHeader('WWW-Authenticate', 'Basic realm="Storyteller", charset="UTF-8"'); json(response, 401, { error: 'Sign in to continue.' }); return; }
        if (request.headers['x-listener-account'] && request.headers['x-listener-account'] !== sha(owner)) { json(response, 409, { error: 'The signed-in account changed. Reload to continue.' }); return; }
        if (method !== 'GET' && method !== 'HEAD' && request.headers.origin !== origin) { json(response, 403, { error: 'Origin mismatch.' }); return; }
      } else {
        const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
        if (token) { const device = await state.read<Device>(`devices/${sha(token)}.json`); if (device && !device.revoked) owner = device.owner; }
      }
      if (!web && route === '/pair/start' && method === 'POST') {
        const input = z.object({ secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(await body(request));
        const ip = request.socket.remoteAddress ?? 'unknown', now = Date.now();
        for (const [key, rate] of pairRate) if (now - rate.since > 600000) pairRate.delete(key);
        const rate = pairRate.get(ip) ?? { since: now, count: 0 }; rate.count++; pairRate.set(ip, rate);
        if (rate.count > 20) { json(response, 429, { error: 'Try again in ten minutes.' }); return; }
        const code = randomBytes(5).toString('hex').toUpperCase();
        await state.write(`pairs/${code}.json`, { code, secretHash: sha(input.secret), expires: now + 600000 } satisfies Pair);
        json(response, 200, { code, url: `${origin}/listen/pair?code=${code}`, expiresAt: now + 600000 }); return;
      }
      if (!web && route === '/pair/poll' && method === 'POST') {
        const input = z.object({ code: z.string().regex(/^[A-F0-9]{10}$/), secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(await body(request));
        await mutate(async () => {
          const pair = await state.read<Pair>(`pairs/${input.code}.json`);
          if (!pair || pair.expires < Date.now() || pair.secretHash !== sha(input.secret)) { json(response, 410, { error: 'Connection expired. Start again.' }); return; }
          if (!pair.owner) { json(response, 202, { pending: true }); return; }
          // Deterministic per-pair token makes polling safe after a lost response; only its hash is stored.
          const token = Buffer.from(sha(`listener-device:${input.secret}:${pair.code}`), 'hex').toString('base64url');
          const key = sha(token); const existing = await state.read<Device>(`devices/${key}.json`);
          if (existing?.revoked) { json(response, 410, { error: 'Device disconnected.' }); return; }
          if (!existing) await state.write(`devices/${key}.json`, { owner: pair.owner, name: 'Android listener', createdAt: new Date().toISOString() });
          json(response, 200, { token });
        }); return;
      }
      if (!owner) { json(response, 401, { error: 'Connect your account.' }); return; }
      const permissions = integrations.permissions ? integrations.permissions(owner) : ownerPermissions;
      if (route === '/capabilities' && method === 'GET') {
        json(response, 200, { schemaVersion: 1, accountKey: sha(owner), permissions,
          sources: integrations.capabilities?.sources ?? ['royal-road', 'file'],
          generation: integrations.capabilities?.generation ?? [],
          updates: integrations.capabilities?.updates ?? 'manual', revision: integrations.revision ?? null }); return;
      }
      if (!permissions.listen || (['/audio', '/follow', '/check', '/jobs', '/issues/resolve'].includes(route) && method === 'POST' && !permissions.manageLibrary)) {
        json(response, 403, { error: 'This account does not have permission for this action.' }); return;
      }
      // Generation routes can enqueue resumable work. Check before any queue mutation.
      if (['/audio', '/check', '/jobs'].includes(route) && method === 'POST' && !permissions.generate) {
        json(response, 403, { error: 'Audio generation is disabled for this account.' }); return;
      }
      const userPath = `users/${sha(owner)}.json`;
      if (web && route === '/pair/approve' && method === 'POST') {
        const input = z.object({ code: z.string().regex(/^[A-F0-9]{10}$/) }).strict().parse(await body(request));
        await mutate(async () => {
          const pair = await state.read<Pair>(`pairs/${input.code}.json`);
          if (!pair || pair.expires < Date.now() || (pair.owner && pair.owner !== owner)) throw new Error('bad_request');
          pair.owner = owner; await state.write(`pairs/${input.code}.json`, pair);
        }); json(response, 200, { connected: true }); return;
      }
      if (route === '/devices/revoke' && method === 'POST' && !web) {
        const token = request.headers.authorization!.slice(7), path = `devices/${sha(token)}.json`;
        await mutate(async () => { const device = (await state.read<Device>(path))!; device.revoked = true; await state.write(path, device); });
        json(response, 200, { disconnected: true }); return;
      }
      if (route === '/library' && method === 'GET') {
        const follows = libraryQueue.follows(sha(owner));
        const books = []; for (const name of await readdir(fictions)) if (id.safeParse(name).success) {
          const book = await new Store(join(fictions, name)).read<Book>('book.json'); if (book) books.push({ ...book, autoDownload: follows.some(f => f.story === book.id && f.enabled && f.mode !== 'download') });
        }
        json(response, 200, { books, accountKey: sha(owner), state: await state.read<ListenerState>(userPath) ?? empty() }); return;
      }
      if (route === '/catalog' && method === 'GET') {
        const follows = libraryQueue.follows(sha(owner)), jobs = libraryQueue.jobs(sha(owner));
        const selected = await state.read<{ owner: string; books: AudioSelection[] }>('bookorbit-selection.json');
        const stories = await storyLibrary(archive, fictions, follows, jobs);
        for (const selection of selected?.owner === sha(owner) ? selected.books : []) {
          const existing = stories.find(s => s.id === selection.story);
          if (existing) Object.assign(existing, { bookorbitSelected: selection.source.selected !== false });
          else {
            const root = new Store(join(fictions, selection.story)), index = await root.read<SourceIndex>('index.json'), book = await root.read<Book>('book.json');
            const chapters = [];
            for (const entry of index?.chapters ?? []) {
              const chapter = await root.read<Chapter>(`sources/${entry.current}.json`); if (!chapter) continue;
              chapters.push({ chapterId: entry.id, sequence: entry.sequence, title: chapter.title, url: chapter.url, downloaded: true,
                editions: Object.entries(book?.editions ?? {}).filter(([, edition]) => edition.chapters.some(c => c.id === entry.id)).map(([name]) => name) });
            }
            const follow = follows.find(f => f.story === selection.story), job = jobs.find(j => j.story === selection.story);
            stories.push({ id: selection.story, title: selection.title, author: selection.author,
              description: selection.reason ?? 'Available from your BookOrbit library', status: selection.supported ? 'Available for audio' : 'Unsupported file',
              url: bookOrbitUrl(selection.source.bookId), checkedAt: '', hasCover: false, chapters,
              follow: follow ? { enabled: follow.enabled, mode: follow.mode, buffer: follow.buffer, intervalHours: follow.intervalHours, nextCheck: follow.nextCheck } : null,
              job: job ? publicJob(job) : null });
          }
          Object.assign(stories.find(s => s.id === selection.story)!, { supported: selection.supported, bookorbitSelected: selection.source.selected !== false });
        }
        for (const story of stories) Object.assign(story, { repair: await repairStatus(fictions, story.id, jobs, story.chapters) });
        json(response, 200, { stories, jobs: jobs.map(publicJob) }); return;
      }
      if (route === '/audio' && method === 'POST') {
        const input = z.object({ story: id, enabled: z.boolean() }).strict().parse(await body(request));
        await mutate(async () => {
          const selected = await state.read<{ owner: string; books: AudioSelection[] }>('bookorbit-selection.json');
          const selection = selected?.owner === sha(owner!) ? selected.books.find(s => s.story === input.story) : undefined;
          if (selection) libraryQueue.audio(sha(owner!), selection, input.enabled);
          else {
            const source = await archiveManifest(archive, input.story);
            if (!source) throw new Error('not_found');
            const old = libraryQueue.follows(sha(owner!)).find(f => f.story === input.story);
            libraryQueue.follow(sha(owner!), { url: source.fiction.url, enabled: input.enabled, mode: old?.mode === 'buffer' ? 'buffer' : 'all', buffer: old?.buffer ?? 5, intervalHours: old?.intervalHours ?? 6 });
          }
        });
        json(response, 200, { saved: true }); return;
      }
      if (route === '/follow' && method === 'POST') {
        const input = followSchema.parse(await body(request));
        if (input.enabled && input.mode !== 'download' && !permissions.generate) { json(response, 403, { error: 'Audio generation is disabled for this account.' }); return; }
        libraryQueue.follow(sha(owner), input); json(response, 200, { saved: true }); return;
      }
      if (route === '/check' && method === 'POST') {
        const input = z.object({ story: id }).strict().parse(await body(request));
        json(response, 200, publicJob(libraryQueue.check(sha(owner), input.story))); return;
      }
      if (route === '/jobs' && method === 'POST') {
        const input = z.object({ id: z.uuid(), action: z.enum(['cancel', 'retry']) }).strict().parse(await body(request));
        json(response, 200, publicJob(libraryQueue.action(sha(owner), input.id, input.action))); return;
      }
      const coverMatch = /^\/stories\/(rr-\d+)\/cover$/.exec(route);
      if (coverMatch && method === 'GET') { const image = await cover(archive, coverMatch[1]!); response.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.bytes.length }); response.end(image.bytes); return; }
      if (route === '/history' && method === 'GET') {
        const story = url.searchParams.get('story') ?? undefined;
        if (story) id.parse(story);
        const before = z.coerce.number().int().positive().safe().parse(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
        json(response, 200, history.list(sha(owner), story, before)); return;
      }
      const text = /^\/stories\/([A-Za-z0-9_-]+)\/([A-Za-z0-9][A-Za-z0-9_-]{0,95})\/text\/([a-f0-9]{64})$/.exec(route);
      if (text && method === 'GET') {
        const { store, chapter, assembly } = await getLocation({ story: text[1]!, edition: editionSchema.parse(text[2]), assembly: text[3]!, seconds: 0 });
        json(response, 200, await reading(store, assembly, chapter)); return;
      }
      if (route === '/progress' && method === 'POST') {
        const input = progressSchema.parse(await body(request));
        if (input.deviceTime > Date.now() + 300000) throw new Error('bad_request');
        const { chapter, assembly } = await getLocation(input);
        const eventLocation = await describeLocation(input), from = input.from ? await describeLocation(input.from) : undefined;
        const seconds = Math.min(input.seconds, assembly.duration);
        await mutate(async () => {
          history.record(sha(owner!), { eventId: input.eventId, deviceTime: input.deviceTime, receivedAt: new Date().toISOString(), reason: input.completed ? 'complete' : input.reason, location: eventLocation, ...(from ? { from } : {}) }, input);
          const saved = await state.read<ListenerState>(userPath) ?? empty(); const key = `${input.story}:${input.edition}:${chapter.id}`;
          const previous = saved.positions[key];
          if (!previous || previous.deviceTime <= input.deviceTime) saved.positions[key] = { ...input, seconds, chapterId: chapter.id, sequence: chapter.sequence, receivedAt: new Date().toISOString() };
          if (input.completed) saved.completed[`${input.story}:${chapter.id}`] = true;
          const segment = assembly.timeline.filter(t => t.start <= seconds).at(-1) ?? assembly.timeline[0];
          const offset = input.completed ? Number.MAX_SAFE_INTEGER : Math.min(...(segment?.spans.map(s => s.start) ?? [0]));
          const seen = saved.seen[input.story];
          if ((input.reason === 'playing' || input.completed) && (!seen || seen.chapter < chapter.sequence || (seen.chapter === chapter.sequence && seen.offset < offset))) saved.seen[input.story] = { chapter: chapter.sequence, offset };
          await state.write(userPath, saved);
        }); json(response, 200, { saved: true }); return;
      }
      if (route === '/issues' && method === 'POST') {
        const input = issueSchema.parse(await body(request)), { chapter, assembly } = await getLocation(input);
        const segment = assembly.timeline.find(t => input.seconds >= t.start && input.seconds < t.end)
          ?? assembly.timeline.find(t => t.start > input.seconds) ?? assembly.timeline.at(-1)!;
        const result = await mutate(async () => {
          const saved = await state.read<ListenerState>(userPath) ?? empty(); const old = saved.issues.find(i => i.eventId === input.eventId);
          if (old) return old;
          const issue: Issue = { ...input, id: randomUUID(), chapterId: chapter.id, sequence: chapter.sequence, source: assembly.source,
            segmentId: segment.segmentId, spans: segment.spans.map(s => s.uid), status: 'open', createdAt: new Date().toISOString() };
          saved.issues.push(issue); await state.write(userPath, saved); return issue;
        }); json(response, 200, result); return;
      }
      if (route === '/issues/resolve' && method === 'POST') {
        const input = z.object({ id: z.uuid(), resolved: z.boolean() }).strict().parse(await body(request));
        await mutate(async () => { const saved = await state.read<ListenerState>(userPath) ?? empty(); const issue = saved.issues.find(i => i.id === input.id); if (!issue) throw new Error('not_found'); issue.status = input.resolved ? 'resolved' : 'open'; await state.write(userPath, saved); });
        json(response, 200, { saved: true }); return;
      }
      const characters = /^\/stories\/([A-Za-z0-9_-]+)\/characters$/.exec(route);
      if (characters && method === 'GET') {
        const story = characters[1]!, { store } = await getBook(story);
        const seen = (await state.read<ListenerState>(userPath))?.seen[story] ?? { chapter: 0, offset: 0 };
        const cast = await store.read<Cast>('cast.json');
        const reached = (p: { chapter: number; offset: number }) => p.chapter < seen.chapter || (p.chapter === seen.chapter && p.offset <= seen.offset);
        json(response, 200, { characters: (cast?.members ?? []).filter(c => reached(c.first)).map(c => ({ id: c.id, name: c.name, portrayal: c.portrayal,
          aliases: c.aliases.filter(a => reached(a.from)).map(a => a.name), firstChapter: c.first.chapter })) }); return;
      }
      const audio = /^\/stories\/([A-Za-z0-9_-]+)\/([A-Za-z0-9][A-Za-z0-9_-]{0,95})\/audio\/([a-f0-9]{64})$/.exec(route);
      if (audio && (method === 'GET' || method === 'HEAD')) {
        const { store, chapter } = await getLocation({ story: audio[1]!, edition: editionSchema.parse(audio[2]), assembly: audio[3]!, seconds: 0 });
        const path = store.path(`assemblies/${chapter.assembly}/chapter.mp3`), size = (await stat(path)).size;
        let start = 0, end = size - 1, status = 200;
        if (request.headers.range) {
          const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
          if (!range || (!range[1] && !range[2])) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }); response.end(); return; }
          start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
          end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }); response.end(); return; }
          status = 206; response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        }
        response.writeHead(status, { 'Content-Type': 'audio/mpeg', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ETag: `"${chapter.checksum}"` });
        if (method === 'HEAD') { response.end(); return; }
        const stream = createReadStream(path, { start, end }); stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response); return;
      }
      if (web && method === 'GET') {
        const filename = ['', '/', '/pair'].includes(route) ? 'index.html' : route === '/app.js' ? 'app.js' : route === '/style.css' ? 'style.css' : route === '/storyteller-mark.png' ? 'storyteller-mark.png' : null;
        if (filename) { const bytes = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../listener-web', filename)); response.writeHead(200, { 'Content-Type': filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.png') ? 'image/png' : 'text/html' }); response.end(bytes); return; }
      }
      throw new Error('not_found');
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof z.ZodError || (error as Error).message === 'bad_request' ? 400 : (error as Error).message === 'not_found' || (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
      json(response, status, { error: status === 400 ? 'Invalid request.' : status === 404 ? 'Item not found.' : 'Unable to save or read this item. Please retry.' });
    }
  });
  server.on('close', () => { history.close(); libraryQueue.close(); });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = process.env.LISTENER_PUBLIC_URL ?? 'http://localhost:8080';
  const mode = process.env.LISTENER_AUTH ?? 'basic';
  if (!['basic', 'authentik'].includes(mode)) throw new Error('LISTENER_AUTH must be basic or authentik');
  const identity = mode === 'basic' ? basicIdentity(origin, process.env.LISTENER_USERNAME ?? 'listener',
    (await readFile(process.env.LISTENER_PASSWORD_FILE ?? '/credential/listener-password', 'utf8')).trim()) : listenerIdentity(origin, {
    uid: process.env.AUTHENTIK_USER_UID ?? '', email: process.env.AUTHENTIK_OWNER_EMAIL ?? '',
    accountEmail: process.env.LISTENER_ACCOUNT_EMAIL ?? '', peers: process.env.AUTHENTIK_PROXY_PEERS ?? '',
  });
  createListener(process.env.AUDIOBOOK_FICTIONS ?? '/fictions', new Store(process.env.LISTENER_STATE ?? '/listener'), identity, origin, process.env.ROYAL_ROAD_ARCHIVE ?? '/archive', mode === 'basic', { capabilities: { sources: ['royal-road', 'file', ...(process.env.BOOKORBIT_PUBLIC_URL ? ['bookorbit'] : [])], generation: (process.env.LISTENER_GENERATION ?? '').split(',').filter(Boolean) }, revision: process.env.STORYTELLER_REVISION })
    .listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
}
