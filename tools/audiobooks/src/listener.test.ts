import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { createListener } from './listener.js';
import { Store, sha } from './store.js';
import { editionSchema } from './book.js';
import { LibraryQueue } from './library-queue.js';

async function fixture(fn: (base: string, state: Store, fiction: Store) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'listener-')), state = new Store(join(root, 'listener')), fiction = new Store(join(root, 'fictions', 'story'));
  const assembly = 'a'.repeat(64);
  await fiction.write('book.json', { schemaVersion: 1, id: 'story', title: 'Fixture', author: 'Test', defaultEdition: 'v3', editions: { v3: { batch: 'one', chapters: [{ id: 'chapter1', sequence: 1, title: 'One', assembly, duration: 20, checksum: sha('0123456789') }] } } });
  await fiction.write(`assemblies/${assembly}/metadata.json`, { id: assembly, source: 'b'.repeat(64), duration: 20, timeline: [{ segmentId: 'first', start: 0, end: 8, spans: [{ uid: 'span1', start: 0, end: 8 }] }, { segmentId: 'last', start: 10, end: 20, spans: [{ uid: 'span2', start: 8, end: 20 }] }] });
  await writeFile(fiction.path(`assemblies/${assembly}/chapter.mp3`), '0123456789');
  await fiction.write(`sources/${'b'.repeat(64)}.json`, { text: 'First.  Second part!', contentHash: sha('First.  Second part!'), url: 'https://www.royalroad.com/fiction/1/example/chapter/1' });
  await fiction.write('cast.json', { members: [{ id: 'alice', name: 'Alice', portrayal: 'Traveler', first: { chapter: 1, offset: 8 }, aliases: [] }, { id: 'later', name: 'Later', first: { chapter: 2, offset: 0 }, aliases: [] }] });
  const server = createListener(join(root, 'fictions'), state, request => {
    const email = request.headers['x-forwarded-user'];
    return typeof email === 'string' ? email : null;
  }, 'https://listener.example.org'); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  try { await fn(`http://127.0.0.1:${address.port}`, state, fiction); } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}
const web = { 'x-forwarded-user': 'owner@example.com', Origin: 'https://listener.example.org', 'Content-Type': 'application/json' };
const location = { story: 'story', edition: 'v3', assembly: 'a'.repeat(64), seconds: 5 };
const post = (base: string, path: string, body: unknown, headers: Record<string, string> = web) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });

test('BookOrbit selection appears before audio and download flags stay account scoped', async () => fixture(async (base, state) => {
  const owner = sha(web['x-forwarded-user']), queue = new LibraryQueue(state.root);
  const selected = [{ story: 'story', title: 'Selected story', author: 'Author', supported: true, source: { bookId: 7, title: 'Selected story', author: 'Author', files: [{ id: 1, path: '/books/Kindle/story.epub', size: 1 }] } },
    { story: 'bo-8', title: 'Pending book', author: '', supported: false, reason: 'Unsupported file', source: { bookId: 8, title: 'Pending book', author: '', files: [] } }];
  try { queue.syncBookOrbit(owner, selected); queue.schedule(); } finally { queue.close(); }
  await state.write('bookorbit-selection.json', { owner, books: selected });
  const library = await (await fetch(base + '/listen/library', { headers: web })).json() as any;
  assert.equal(library.books[0].autoDownload, true);
  const catalog = await (await fetch(base + '/listen/catalog', { headers: web })).json() as any;
  assert.equal(catalog.stories.find((s: any) => s.id === 'bo-8').supported, false);
  assert.equal(catalog.stories.find((s: any) => s.id === 'story').follow.owner, undefined);
  assert.equal(JSON.stringify(catalog).includes('/books/Kindle'), false);
  const other = { ...web, 'x-forwarded-user': 'other@example.com' };
  assert.equal((await (await fetch(base + '/listen/library', { headers: other })).json() as any).books[0].autoDownload, false);
  assert.equal((await (await fetch(base + '/listen/catalog', { headers: other })).json() as any).stories.length, 0);
}));

test('catalog exposes repair status to its owner without casting evidence', async () => fixture(async (base, state, fiction) => {
  const owner = sha(web['x-forwarded-user']), queue = new LibraryQueue(state.root);
  await state.write('bookorbit-selection.json', { owner, books: [{ story: 'story', title: 'Fixture', author: 'Test', supported: true, source: { bookId: 1, files: [] } }] });
  try { queue.repair(owner, 'story', { chapter1: 'a'.repeat(64) }, 'Fix voices'); } finally { queue.close(); }
  await fiction.write('casting-review.json', { decisions: [{ evidence: 'Secret future identity' }] });
  const response = await fetch(base + '/listen/catalog', { headers: web });
  const catalog = await response.json() as { stories: { repair: { title: string; chapters: { label: string }[] } }[] };
  assert.equal(response.status, 200);
  assert.equal(catalog.stories[0]!.repair.title, 'Audio repair queued');
  assert.equal(catalog.stories[0]!.repair.chapters[0]!.label, 'Queued for reanalysis and recasting');
  assert.equal(JSON.stringify(catalog).includes('Secret future identity'), false);
  const other = await (await fetch(base + '/listen/catalog', { headers: { ...web, 'x-forwarded-user': 'other@example.com' } })).json() as { stories: unknown[] };
  assert.deepEqual(other.stories, []);
}));

test('paired Listener can enable an untagged book without granting access to another account', async () => fixture(async (base, state) => {
  const owner = sha(web['x-forwarded-user']), token = randomBytes(32).toString('base64url');
  const selection = { story: 'story', title: 'Untagged book', author: 'Author', supported: true,
    source: { bookId: 77, title: 'Untagged book', author: 'Author', selected: false, files: [{ id: 77, path: '/books/Kindle/story.epub', size: 1 }] } };
  await state.write('bookorbit-selection.json', { owner, books: [selection] });
  await state.write(`devices/${sha(token)}.json`, { owner: web['x-forwarded-user'], name: 'Test device', createdAt: new Date().toISOString() });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const before = await (await fetch(base + '/api/listener/catalog', { headers })).json() as any;
  assert.equal(before.stories[0].bookorbitSelected, false); assert.equal(before.stories[0].follow, null);
  assert.equal((await post(base, '/api/listener/audio', { story: 'story', enabled: true }, web)).status, 401);
  assert.equal((await post(base, '/listen/audio', { story: 'story', enabled: true }, { ...web, 'x-forwarded-user': 'other@example.com' })).status, 404);
  assert.equal((await post(base, '/api/listener/audio', { story: 'story', enabled: true }, headers)).status, 200);
  assert.equal((await post(base, '/api/listener/audio', { story: 'story', enabled: true }, headers)).status, 200);
  const after = await (await fetch(base + '/api/listener/catalog', { headers })).json() as any;
  assert.equal(after.stories[0].follow.enabled, true); assert.equal(after.jobs.length, 1);
  assert.equal(JSON.stringify(after).includes('/books/Kindle'), false);
  assert.equal((await (await fetch(base + '/api/listener/library', { headers })).json() as any).books[0].autoDownload, true);
  assert.equal((await post(base, '/api/listener/audio', { story: 'story', enabled: false }, headers)).status, 200);
  const off = await (await fetch(base + '/api/listener/catalog', { headers })).json() as any;
  assert.equal(off.stories[0].follow.enabled, false); assert.equal(off.jobs[0].status, 'cancelled');
  assert.equal((await post(base, '/api/listener/audio', { story: 'bo-123456', enabled: true }, headers)).status, 404);
}));

test('local Qwen edition streams and keeps progress and issues separate from v3', async () => fixture(async (base, _state, fiction) => {
  const book = (await fiction.read<any>('book.json'))!;
  book.editions.qwen = structuredClone(book.editions.v3);
  await fiction.write('book.json', book);
  const response = await fetch(base + `/listen/stories/story/qwen/audio/${location.assembly}`, { headers: { ...web, Range: 'bytes=2-5' } });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), '2345');
  const local = { ...location, edition: 'qwen', eventId: randomUUID(), deviceTime: 3000 };
  assert.equal((await post(base, '/listen/progress', local)).status, 200);
  assert.equal((await post(base, '/listen/issues', { ...location, edition: 'qwen', eventId: randomUUID(), kind: 'voice', note: 'Local cast' })).status, 200);
  const library = await (await fetch(base + '/listen/library', { headers: web })).json() as any;
  assert.equal(library.state.positions['story:qwen:chapter1'].seconds, 5);
  assert.equal(library.state.positions['story:v3:chapter1'], undefined);
  assert.equal(library.state.issues[0].edition, 'qwen');
}));

test('local Breeze edition streams and keeps progress and issues separate from v3', async () => fixture(async (base, _state, fiction) => {
  const book = (await fiction.read<any>('book.json'))!;
  book.editions.breeze = structuredClone(book.editions.v3);
  await fiction.write('book.json', book);
  const response = await fetch(base + `/listen/stories/story/breeze/audio/${location.assembly}`, { headers: { ...web, Range: 'bytes=2-5' } });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), '2345');
  const local = { ...location, edition: 'breeze', eventId: randomUUID(), deviceTime: 3000 };
  assert.equal((await post(base, '/listen/progress', local)).status, 200);
  assert.equal((await post(base, '/listen/issues', { ...location, edition: 'breeze', eventId: randomUUID(), kind: 'voice', note: 'Local cast' })).status, 200);
  const library = await (await fetch(base + '/listen/library', { headers: web })).json() as any;
  assert.equal(library.state.positions['story:breeze:chapter1'].seconds, 5);
  assert.equal(library.state.positions['story:v3:chapter1'], undefined);
  assert.equal(library.state.issues[0].edition, 'breeze');
}));

test('local Breeze hybrid edition streams and keeps progress and issues separate from v3', async () => fixture(async (base, _state, fiction) => {
  const book = (await fiction.read<any>('book.json'))!;
  book.editions['breeze-hybrid'] = structuredClone(book.editions.v3);
  await fiction.write('book.json', book);
  const response = await fetch(base + `/listen/stories/story/breeze-hybrid/audio/${location.assembly}`, { headers: { ...web, Range: 'bytes=2-5' } });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), '2345');
  const local = { ...location, edition: 'breeze-hybrid', eventId: randomUUID(), deviceTime: 3000 };
  assert.equal((await post(base, '/listen/progress', local)).status, 200);
  assert.equal((await post(base, '/listen/issues', { ...location, edition: 'breeze-hybrid', eventId: randomUUID(), kind: 'voice', note: 'Local cast' })).status, 200);
  const library = await (await fetch(base + '/listen/library', { headers: web })).json() as any;
  assert.equal(library.state.positions['story:breeze-hybrid:chapter1'].seconds, 5);
  assert.equal(library.state.positions['story:v3:chapter1'], undefined);
  assert.equal(library.state.issues[0].edition, 'breeze-hybrid');
}));

for (const edition of ['Inworld', 'future-provider_42']) test(`${edition} streams and keeps progress and issues separate from v3`, async () => fixture(async (base, state, fiction) => {
  const book = (await fiction.read<any>('book.json'))!;
  book.editions[edition] = structuredClone(book.editions.v3);
  await fiction.write('book.json', book);
  const response = await fetch(base + `/listen/stories/story/${edition}/audio/${location.assembly}`, { headers: { ...web, Range: 'bytes=2-5' } });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), '2345');
  const text = await fetch(base + `/listen/stories/story/${edition}/text/${location.assembly}`, { headers: web });
  assert.equal(text.status, 200);
  const local = { ...location, edition, eventId: randomUUID(), deviceTime: 3000 };
  assert.equal((await post(base, '/listen/progress', local)).status, 200);
  assert.equal((await post(base, '/listen/issues', { ...location, edition, eventId: randomUUID(), kind: 'voice', note: 'Local cast' })).status, 200);
  const library = await (await fetch(base + '/listen/library', { headers: web })).json() as any;
  assert.equal(library.state.positions[`story:${edition}:chapter1`].seconds, 5);
  assert.equal(library.state.positions['story:v3:chapter1'], undefined);
  assert.equal(library.state.issues[0].edition, edition);
  const token = randomBytes(32).toString('base64url');
  await state.write(`devices/${sha(token)}.json`, { owner: web['x-forwarded-user'], name: 'Edition test', createdAt: new Date().toISOString() });
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(base + `/api/listener/stories/story/${edition}/text/${location.assembly}`, { headers })).status, 200);
  assert.equal((await fetch(base + `/api/listener/stories/story/${edition}/audio/${location.assembly}`, { method: 'HEAD', headers })).status, 200);
  assert.equal((await fetch(base + `/api/listener/stories/story/unpublished/audio/${location.assembly}`, { headers })).status, 404);

}));

test('library and audio require authentication; public API never trusts a spoofed proxy user', async () => fixture(async base => {
  assert.equal((await fetch(base + '/api/listener/library', { headers: web })).status, 401);
  assert.equal((await fetch(base + '/listen/library')).status, 401);
  assert.equal((await fetch(base + '/listen/library', { headers: web })).status, 200);
  assert.equal((await post(base, '/listen/progress', {}, { ...web, Origin: 'https://evil.example' })).status, 403);
}));
test('device pairing requires browser confirmation and secret; revoked devices cannot reconnect by polling', async () => fixture(async base => {
  const secret = randomBytes(32).toString('base64url');
  const pair = await (await post(base, '/api/listener/pair/start', { secret })).json() as { code: string };
  assert.equal((await post(base, '/api/listener/pair/poll', { code: pair.code, secret })).status, 202);
  assert.equal((await post(base, '/listen/pair/approve', { code: pair.code })).status, 200);
  assert.equal((await post(base, '/api/listener/pair/poll', { code: pair.code, secret: randomBytes(32).toString('base64url') })).status, 410);
  const result = await (await post(base, '/api/listener/pair/poll', { code: pair.code, secret })).json() as { token: string };
  const auth = { ...web, Authorization: `Bearer ${result.token}` };
  assert.equal((await fetch(base + '/api/listener/library', { headers: auth })).status, 200);
  assert.equal((await post(base, '/api/listener/devices/revoke', {}, auth)).status, 200);
  assert.equal((await fetch(base + '/api/listener/library', { headers: auth })).status, 401);
  assert.equal((await post(base, '/api/listener/pair/poll', { code: pair.code, secret })).status, 410);
}));
test('audio supports valid range and suffix seeks and rejects invalid ranges', async () => fixture(async base => {
  const path = base + `/listen/stories/story/v3/audio/${location.assembly}`;
  const response = await fetch(path, { headers: { ...web, Range: 'bytes=2-5' } });
  assert.equal(response.status, 206); assert.equal(await response.text(), '2345'); assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await (await fetch(path, { headers: { ...web, Range: 'bytes=-3' } })).text(), '789');
  for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=0-2,4-5']) assert.equal((await fetch(path, { headers: { ...web, Range: range } })).status, 416);
  assert.equal((await fetch(path.replace('/v3/', '/flash/'), { headers: web })).status, 404);
}));
test('progress is owner scoped, keeps latest position, and reveals characters only after their source position', async () => fixture(async base => {
  const progress = { ...location, eventId: randomUUID(), deviceTime: 2000, completed: false };
  assert.equal((await post(base, '/listen/progress', progress)).status, 200);
  await post(base, '/listen/progress', { ...progress, eventId: randomUUID(), seconds: 1, deviceTime: 1000 });
  let library = await (await fetch(base + '/listen/library', { headers: web })).json() as any;
  assert.equal(library.state.positions['story:v3:chapter1'].seconds, 5);
  assert.equal((await (await fetch(base + '/listen/stories/story/characters', { headers: web })).json() as any).characters.length, 0);
  await post(base, '/listen/progress', { ...progress, eventId: randomUUID(), seconds: 9, deviceTime: 3000 }); // join silence must not expose last segment
  assert.equal((await (await fetch(base + '/listen/stories/story/characters', { headers: web })).json() as any).characters.length, 0);
  await post(base, '/listen/progress', { ...progress, eventId: randomUUID(), seconds: 11, deviceTime: 4000 });
  assert.equal((await (await fetch(base + '/listen/stories/story/characters', { headers: web })).json() as any).characters[0].name, 'Alice');
  library = await (await fetch(base + '/listen/library', { headers: { ...web, 'x-forwarded-user': 'other@example.com' } })).json() as any;
  assert.deepEqual(library.state.positions, {});
  assert.equal((await post(base, '/listen/progress', { ...progress, eventId: randomUUID(), seconds: 99 })).status, 400);
}));
test('issue retries are idempotent and retain original assembly, source and spans', async () => fixture(async (base, _state, fiction) => {
  const input = { ...location, eventId: randomUUID(), kind: 'voice', note: 'Wrong voice' };
  const first = await (await post(base, '/listen/issues', input)).json() as any;
  const second = await (await post(base, '/listen/issues', input)).json() as any;
  assert.equal(first.id, second.id); assert.deepEqual(first.spans, ['span1']); assert.equal(first.segmentId, 'first');
  await fiction.object('book-history', await fiction.read('book.json'));
  await fiction.write('book.json', { id: 'story', editions: {} });
  assert.equal((await post(base, '/listen/issues', { ...input, eventId: randomUUID(), seconds: 11 })).status, 200);
  assert.equal((await post(base, '/listen/issues/resolve', { id: first.id, resolved: true })).status, 200);
  const library = await (await fetch(base + '/listen/library', { headers: web })).json() as any;
  assert.equal(library.state.issues.length, 2); assert.equal(library.state.issues[0].status, 'resolved'); assert.equal(library.state.issues[0].assembly, location.assembly);
}));


test('reading follows the recording source with exact passage offsets and joins', async () => fixture(async (base, _state, fiction) => {
  const response = await fetch(base + `/listen/stories/story/v3/text/${location.assembly}`, { headers: web });
  assert.equal(response.status, 200);
  const text = await response.json() as any;
  assert.equal(text.passages.map((p: any) => p.text).join(''), 'First.  Second part!');
  assert.equal(text.passages[1].start, 10); assert.equal(text.passages[1].startOffset, 8);
  await fiction.write('sources/newer.json', { text: 'A revised chapter.' });
  assert.equal((await (await fetch(base + `/listen/stories/story/v3/text/${location.assembly}`, { headers: web })).json() as any).text, text.text);
  assert.equal((await fetch(base + `/api/listener/stories/story/v3/text/${location.assembly}`, { headers: web })).status, 401);
}));

test('navigation history retains retries, backwards jumps, passages and account isolation', async () => fixture(async (base) => {
  const first = { ...location, seconds: 3, eventId: randomUUID(), deviceTime: 1000, reason: 'playing' };
  const jump = { ...location, seconds: 15, eventId: randomUUID(), deviceTime: 2000, reason: 'passage', from: { ...location, seconds: 3 } };
  assert.equal((await post(base, '/listen/progress', first)).status, 200);
  assert.equal((await post(base, '/listen/progress', jump)).status, 200);
  assert.equal((await post(base, '/listen/progress', jump)).status, 200);
  const data = await (await fetch(base + '/listen/history?story=story', { headers: web })).json() as any;
  assert.equal(data.entries.length, 2);
  assert.equal(data.entries[0].location.passage, 'last'); assert.equal(data.entries[0].location.excerpt, 'Second part!');
  assert.equal(data.entries[0].from.passage, 'first'); assert.equal(data.entries[0].from.seconds, 3);
  const saved = await (await fetch(base + '/listen/library', { headers: web })).json() as any;
  assert.equal(saved.state.positions['story:v3:chapter1'].seconds, 15);
  assert.equal(saved.state.seen.story.offset, 0, 'An accidental tap must not advance heard progress');
  assert.equal((await post(base, '/listen/progress', { ...jump, seconds: 18 })).status, 400, 'A reused event ID cannot change meaning');
  assert.equal((await post(base, '/listen/progress', { ...first, seconds: 2, eventId: randomUUID(), deviceTime: 3000, reason: 'restore', from: { ...location, seconds: 15 } })).status, 200);
  const restored = await (await fetch(base + '/listen/history', { headers: web })).json() as any;
  assert.equal(restored.entries[0].reason, 'restore'); assert.equal(restored.entries[0].location.seconds, 2);
  const other = await (await fetch(base + '/listen/history', { headers: { ...web, 'x-forwarded-user': 'other@example.com' } })).json() as any;
  assert.deepEqual(other.entries, []);
  const earlier = await (await fetch(base + `/listen/history?before=${restored.entries[0].sequence}`, { headers: web })).json() as any;
  assert.equal(earlier.entries.length, 2);
}));

test('automatic chapter jobs require an authenticated account and preserve owner isolation', async () => fixture(async base => {
  const follow = { url: 'https://www.royalroad.com/fiction/123/example', enabled: true, mode: 'buffer' };
  assert.equal((await post(base, '/api/listener/follow', follow)).status, 401);
  assert.equal((await post(base, '/listen/follow', follow, { ...web, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(base, '/listen/follow', { ...follow, url: 'https://example.com/fiction/123' })).status, 400);
  assert.equal((await post(base, '/listen/follow', follow, { ...web, 'x-listener-account': sha('other@example.com') })).status, 409);
  assert.equal((await post(base, '/listen/follow', follow)).status, 200);
  assert.equal((await post(base, '/listen/follow', follow)).status, 200);
  const catalog = await (await fetch(base + '/listen/catalog', { headers: web })).json() as any;
  assert.equal(catalog.jobs.length, 1); assert.equal(catalog.jobs[0].buffer, 5); assert.equal(catalog.jobs[0].owner, undefined);
  const id = catalog.jobs[0].id, other = { ...web, 'x-forwarded-user': 'other@example.com' };
  assert.equal((await post(base, '/listen/jobs', { id, action: 'cancel' }, other)).status, 404);
  assert.deepEqual((await (await fetch(base + '/listen/catalog', { headers: other })).json() as any).jobs, []);
  assert.equal((await post(base, '/listen/jobs', { id, action: 'cancel' })).status, 200);
  assert.equal((await post(base, '/listen/jobs', { id, action: 'retry' })).status, 200);
  assert.equal((await post(base, '/listen/check', { story: 'rr-123' })).status, 200);
  assert.equal((await (await fetch(base + '/listen/catalog', { headers: web })).json() as any).jobs.length, 1);
}));

test('edition identifiers reject unsafe paths and reserved object keys', () => {
  for (const value of ['../escape', 'a/b', 'a:b', '__proto__', 'constructor', 'prototype', '', 'a'.repeat(97)]) assert.equal(editionSchema.safeParse(value).success, false);
});
