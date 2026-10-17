import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { epubChapters } from './bookorbit-ingest.js';
import { selections } from './bookorbit-selection.js';
import { LibraryQueue } from './library-queue.js';

test('BookOrbit tags preserve RR identity, settings, cancellation, and retagging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bo-queue-')); const q = new LibraryQueue(root);
  try {
    const owner = 'a'.repeat(64), selected = selections([{ bookId: 1, title: 'Story', author: 'Author', files: [{ id: 1, path: '/books/RoyalRoad/rr-42.epub', size: 1 }] }]);
    q.follow(owner, { url: 'https://www.royalroad.com/fiction/42', enabled: true, mode: 'buffer', buffer: 3, intervalHours: 6 });
    q.syncBookOrbit(owner, selected); assert.equal(q.follows(owner)[0]!.mode, 'buffer'); assert.equal(q.jobs(owner)[0]!.bookorbit?.bookId, 1);
    q.syncBookOrbit(owner, []); assert.equal(q.jobs(owner)[0]!.status, 'cancelled'); assert.equal(q.follows(owner)[0]!.enabled, false);
    q.syncBookOrbit(owner, selected); q.schedule(Date.now() + 7 * 3600000); assert.equal(q.follows(owner)[0]!.enabled, true); assert.equal(q.jobs(owner).filter(j => j.status === 'queued').length, 1);
    const other = selections([{ bookId: 2, title: 'Book', author: '', files: [{ id: 2, path: '/books/Kindle/book.epub', size: 1 }] }]);
    q.syncBookOrbit(owner, other); q.schedule(); assert.equal(q.follows(owner).find(f => f.story === 'bo-2')!.mode, 'all');
    assert.throws(() => q.follow(owner, { url: 'https://books.example.org/book/99', enabled: true, mode: 'all', buffer: 5, intervalHours: 6 }));
  } finally { q.close(); await rm(root, { recursive: true }); }
});
test('Listener choices survive tag reconciliation, cancel work and preserve Royal Road identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bo-controls-')), q = new LibraryQueue(root);
  const owner = 'a'.repeat(64);
  const book = selections([{ bookId: 6, title: 'The Allbright System', author: '', selected: false, files: [{ id: 6, path: '/books/RoyalRoad/rr-42.epub', size: 1 }] }])[0]!;
  try {
    q.syncBookOrbit(owner, [book]); q.schedule(); assert.equal(q.follows(owner).length, 0);
    q.audio(owner, book, true); q.audio(owner, book, true);
    assert.equal(q.jobs(owner).filter(j => j.status === 'queued').length, 1);
    q.syncBookOrbit(owner, [book]); assert.equal(q.follows(owner)[0]!.enabled, true);
    q.follow(owner, { url: 'https://books.example.org/book/6', enabled: true, mode: 'buffer', buffer: 3, intervalHours: 8 });
    assert.equal(q.follows(owner)[0]!.story, 'rr-42');
    assert.equal(q.follows(owner)[0]!.listenerSelected, true);
    q.audio(owner, book, false); assert.equal(q.jobs(owner)[0]!.status, 'cancelled');
    q.syncBookOrbit(owner, [{ ...book, source: { ...book.source, selected: true } }]);
    assert.equal(q.follows(owner)[0]!.enabled, false);
    q.audio(owner, book, true); assert.equal(q.follows(owner)[0]!.mode, 'buffer');
    q.lease('worker'); const job = q.claim('worker')!;
    q.audio(owner, book, false); assert.equal(q.get(job.id)!.cancel, true); assert.equal(q.get(job.id)!.status, 'running');
    q.audio(owner, book, true); q.schedule(); assert.equal(q.follows(owner)[0]!.nextCheck <= Date.now(), true);
    job.status = 'cancelled'; q.update(job); q.schedule(); assert.equal(q.jobs(owner).filter(j => j.status === 'queued').length, 1);
    assert.throws(() => q.audio(owner, { ...book, supported: false }, true));
    q.syncBookOrbit(owner, []); assert.equal(q.follows(owner)[0]!.bookorbit!.files.length, 0);
  } finally { q.close(); await rm(root, { recursive: true }); }
});

test('EPUB spine preserves paragraphs and stable paths while skipping navigation', () => {
  const bytes = zipSync(Object.fromEntries(Object.entries({
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    'OEBPS/content.opf': '<package><manifest><item id="nav" href="nav.xhtml" properties="nav"/><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/></manifest><spine><itemref idref="nav"/><itemref idref="b"/><itemref idref="a"/></spine></package>',
    'OEBPS/nav.xhtml': '<html><body>Navigation</body></html>', 'OEBPS/a.xhtml': '<html><body><h1>First</h1><p>Hello.</p></body></html>',
    'OEBPS/b.xhtml': '<html><body><h1>Second</h1><p>A.</p><p>B.</p></body></html>',
  }).map(([k, v]) => [k, strToU8(v)])));
  const encrypted = (algorithm: string) => zipSync({ ...unzipSync(bytes), 'META-INF/encryption.xml': strToU8(`<enc:encryption xmlns:enc="urn:encryption"><enc:EncryptedData><enc:EncryptionMethod Algorithm="${algorithm}"/></enc:EncryptedData></enc:encryption>`) });
  assert.throws(() => epubChapters(encrypted('http://www.w3.org/2001/04/xmlenc#aes256-cbc')), /encrypted/);
  assert.equal(epubChapters(encrypted('http://www.idpf.org/2008/embedding')).length, 2);
  const chapters = epubChapters(bytes); assert.equal(chapters.length, 2); assert.equal(chapters[0]!.key, 'OEBPS/b.xhtml'); assert.match(chapters[0]!.text, /A\.\n\nB\./);
  assert.equal(selections([{ bookId: 3, title: 'Unsupported', author: '', files: [{ id: 1, path: '/books/x.mobi', size: 1 }] }])[0]!.supported, false);
});
