import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// The browser exercises real DOM/audio behavior against a synthetic library.
// Backend authorization, persistence and source mapping have separate integration tests.
const wave = Buffer.alloc(44 + 22050 * 2 * 90);
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(22050, 24); wave.writeUInt32LE(44100, 28); wave.writeUInt16LE(2, 32);
wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
const chapter = (assembly) => ({ id: 'one', sequence: 1, title: 'Chapter one', assembly, duration: 90 });
const state = { positions: {}, completed: {}, seen: {}, issues: [] };
const book = { id: 'fixture', title: 'A quiet journey', author: 'Test author', defaultEdition: 'v3',
  editions: { v3: { chapters: [chapter('a'.repeat(64))] }, flash: { chapters: [chapter('b'.repeat(64))] }, qwen: { chapters: [chapter('c'.repeat(64))] } } };
const posts = [];
let offline = false, accountKey = 'test';
const catalog = { jobs: [], stories: [{ id: 'rr-1', title: 'A Royal Road story', author: 'An author', url: 'https://www.royalroad.com/fiction/1', description: 'A saved story.', status: 'ONGOING', hasCover: false, follow: null, chapters: [{ chapterId: 2, title: 'Opening chapter', downloaded: true, editions: [] }] }] };
catalog.stories.push({ id: 'fixture', title: book.title, author: book.author, url: 'https://www.royalroad.com/fiction/2', description: '', status: 'ONGOING', chapters: [], repair: { title: 'Audio repair in progress', detail: 'Chapter one · Generating audio', completed: 0, total: 2, updatedAt: '2026-10-11T20:00:00Z', chapters: [{ id: 'one', title: 'Chapter one', label: 'Generating audio' }, { id: 'two', title: 'Chapter two', label: 'Queued for reanalysis and recasting' }] } });
const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (req.method === 'POST') {
    if (req.headers['x-listener-account'] && req.headers['x-listener-account'] !== accountKey) { res.statusCode = 409; res.end('{}'); return; }
    if (offline) { res.statusCode = 503; res.end('{}'); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks)); posts.push({ path, data });
    if (path === '/listen/follow') catalog.stories[0].follow = data;
    if (path === '/listen/issues') state.issues.push({ ...data, id: data.eventId, sequence: 1, status: 'open' });
    if (path === '/listen/issues/resolve') state.issues.find(i => i.id === data.id).status = data.resolved ? 'resolved' : 'open';
    if (path === '/listen/progress') {
      state.positions[`fixture:${data.edition}:one`] = data;
      if (data.completed) state.completed['fixture:one'] = true;
    }
    res.setHeader('Content-Type', 'application/json'); res.end('{}'); return;
  }
  if (path === '/listen/catalog') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(catalog)); return; }
  if (path === '/listen/library') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ books: [book], state, accountKey })); return; }
  if (path === '/listen/history') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ entries: posts.filter(p => p.path === '/listen/progress').map(p => ({ ...p.data, location: { ...p.data, chapterTitle: 'Chapter one', passageIndex: Math.floor(p.data.seconds / 5), storySeconds: p.data.seconds, storyDuration: 90, excerpt: 'Saved exact text.' }, from: p.data.from && { ...p.data.from, chapterTitle: 'Chapter one' } })).reverse(), before: null })); return; }
  if (path.includes('/text/')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ url: 'https://www.royalroad.com/fiction/1/test', passages: Array.from({length: 18}, (_, i) => ({ id: `p${i}`, start: i * 5, end: (i + 1) * 5, text: `Passage ${i + 1}. ` + 'The traveler walked down the quiet road. '.repeat(8) + '\n\n' })) })); return; }
  if (path.includes('/audio/')) {
    res.setHeader('Content-Type', 'audio/wav'); res.setHeader('Accept-Ranges', 'bytes');
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), wave.length - 1) : wave.length - 1;
    if (range) { res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${wave.length}`); }
    res.setHeader('Content-Length', end - start + 1); res.end(wave.subarray(start, end + 1)); return;
  }
  const name = path === '/listen/app.js' ? 'app.js' : path === '/listen/style.css' ? 'style.css' : path === '/listen/storyteller-mark.png' ? 'storyteller-mark.png' : 'index.html';
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.png') ? 'image/png' : 'text/html');
  res.end(await readFile(new URL(`./listener-web/${name}`, import.meta.url)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [320, 768, 840, 1024, 1440]) {
    accountKey = 'test'; offline = false; state.issues = []; state.positions = {}; state.completed = {}; posts.length = 0;
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: width === 840 ? 'dark' : 'light', reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/listen');
    await page.getByRole('heading', { name: book.title }).waitFor();
    assert.equal(await page.locator('#library-view').isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'v3', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Listen', exact: true }).count(), 0);
    await page.getByText('1 unread audio chapter · 1:30 remaining', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('heading', { name: 'A Royal Road story', exact: true }).waitFor();
    await page.locator('#show-tools').click();
    await page.locator('#story-url').fill('https://www.royalroad.com/fiction/1');
    await page.locator('#follow-story button').click();
    await page.locator('#show-library').click();
    await page.getByRole('link', { name: 'A Royal Road story', exact: true }).click();
    await page.getByRole('button', { name: 'Pause automatic checks', exact: true }).waitFor();
    await page.locator('#back-library').click();
    await page.getByRole('link', { name: book.title, exact: true }).click();
    await page.getByRole('heading', { name: 'Audio repair in progress' }).waitFor();
    await page.getByText('Chapter repair queue', { exact: true }).click();
    await page.getByText('Queued for reanalysis and recasting', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.LISTENER_SCREENSHOTS) await page.screenshot({ path: `${process.env.LISTENER_SCREENSHOTS}/web-${width}.png`, fullPage: true });
    assert.equal(await page.getByRole('button', { name: 'v3', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.goBack();
    assert.equal(await page.locator('#library-view').isVisible(), true);
    await page.getByRole('link', { name: book.title, exact: true }).click();
    assert.equal(posts.find(p => p.path === '/listen/follow').data.mode, 'buffer');
    await page.getByRole('button', { name: 'Listen', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('audio').currentTime > 0);
    await page.locator('.passage').nth(0).waitFor();
    await page.locator('#audio').evaluate(a => a.pause());
    await page.locator('.passage').nth(4).click();
    await page.waitForFunction(() => document.getElementById('audio').currentTime >= 20);
    assert.equal(await page.locator('.passage').nth(4).getAttribute('aria-current'), 'true');
    assert.equal(await page.locator('#audio').evaluate(a => a.paused), true, 'Passage seek preserves pause');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('listener:test')).pending.length === 0);
    const jump = posts.filter(p => p.data.reason === 'passage').at(-1).data;
    assert.equal(jump.seconds, 20); assert(jump.from.seconds < 5);
    await page.getByRole('button', { name: 'Undo jump' }).click();
    await page.waitForFunction(() => document.getElementById('audio').currentTime < 5);
    await page.locator('.passage').nth(6).click();
    await page.waitForFunction(() => document.getElementById('audio').currentTime >= 30);
    await page.getByRole('button', { name: 'Mark issue', exact: true }).click();
    await page.getByLabel('Optional note').fill('The voice changes here.');
    await page.getByRole('button', { name: 'Save issue', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('message').textContent.startsWith('Issue saved'));
    const issue = posts.find(p => p.path === '/listen/issues').data;
    assert.equal(issue.assembly, 'a'.repeat(64)); assert.equal(issue.seconds, 30);
    offline = true;
    await page.locator('.passage').nth(8).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('listener:test')).pending.length > 0);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('audio').currentTime >= 40);
    assert(await page.evaluate(() => JSON.parse(localStorage.getItem('listener:test')).pending.length > 0));
    offline = false;
    await page.evaluate(() => dispatchEvent(new Event('online')));
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('listener:test')).pending.length === 0);
    await page.locator('#show-tools').click();
    await page.locator('#show-history').click();
    await page.getByText('Saved exact text.', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Reading', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('audio').currentTime >= 30);
    assert.equal(await page.locator('#audio').evaluate(a => a.paused), true, 'Reopening restores without autoplay');
    await page.getByRole('button', { name: 'Following audio', exact: true }).click();
    assert.equal(await page.locator('#follow').getAttribute('aria-pressed'), 'false');
    await page.getByRole('button', { name: 'Follow audio', exact: true }).click();
    assert.equal(await page.locator('#follow').getAttribute('aria-pressed'), 'true');
    await page.getByLabel('Text size').selectOption('24');
    assert.equal(await page.locator('.passage').first().evaluate(e => getComputedStyle(e).fontSize), '24px');
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await page.getByRole('link', { name: book.title, exact: true }).click();
    await page.getByRole('button', { name: 'Qwen local', exact: true }).click();
    await page.getByRole('button', { name: 'Listen', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('audio').getAttribute('src').includes('/qwen/audio/') && document.getElementById('audio').currentTime > 0);
    assert.equal(await page.locator('#edition-label').textContent(), 'Qwen local edition');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByLabel('Text size').selectOption('14');
    await page.screenshot({path: `${process.env.SCREENSHOTS ?? "/tmp"}/listener-reader-${width}.png`, fullPage: true});
    await page.locator('#show-library').click();
    await page.screenshot({path: `${process.env.SCREENSHOTS ?? "/tmp"}/listener-library-${width}.png`, fullPage: true});
    await page.reload();
    await page.waitForFunction(() => document.getElementById('audio').readyState > 0);
    assert.equal(await page.locator('#library-view').isVisible(), true, 'Saved progress must not replace the library on launch');
    assert.equal(await page.locator('#mini-player').isVisible(), true);
    await page.locator('#mini-open').click();
    offline = true;
    await page.locator('#audio').evaluate(a => a.pause());
    await page.locator('.passage').nth(5).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('listener:test')).pending.length > 0);
    const acceptedBeforeSwitch = posts.filter(p => p.path === '/listen/progress').length;
    accountKey = 'other'; state.positions = {}; offline = false;
    await page.locator('#refresh').click();
    await page.waitForFunction(() => localStorage.getItem('listener:other') !== null);
    assert.equal(posts.filter(p => p.path === '/listen/progress').length, acceptedBeforeSwitch, 'Old account events cannot sync into a new account');
    assert(await page.evaluate(() => JSON.parse(localStorage.getItem('listener:test')).pending.length > 0));
    assert.deepEqual(errors, []);
    await page.close(); console.log(`PASS: reader, passage seeks, undo, restored positions and editions at ${width}px`);
  }
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
