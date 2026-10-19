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
for(let frame=0;frame<(wave.length-44)/2;frame++)wave.writeInt16LE(Math.round(8000*Math.sin(2*Math.PI*440*frame/22050)),44+frame*2);
const chapter = (assembly) => ({ id: 'one', sequence: 1, title: 'Chapter one', assembly, duration: 90 });
const state = { positions: {}, completed: {}, seen: {}, issues: [] };
const book = { id: 'fixture', title: 'A quiet journey', author: 'Test author', defaultEdition: 'v3',
  editions: { v3: { chapters: [chapter('a'.repeat(64))] }, flash: { chapters: [chapter('b'.repeat(64))] }, qwen: { chapters: [chapter('c'.repeat(64))] } } };
const posts = [];
let offline = false, accountKey = 'test';
let noteMetadata = false, textDelay = 0;
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
      const id = book.editions[data.edition]?.chapters.find(c => c.assembly === data.assembly)?.id || 'one';
      state.positions[`fixture:${data.edition}:${id}`] = data;
      if (data.completed) state.completed[`fixture:${id}`] = true;
    }
    res.setHeader('Content-Type', 'application/json'); res.end('{}'); return;
  }
  if (path === '/listen/catalog') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(catalog)); return; }
  if (path === '/listen/library') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ books: [book], state, accountKey })); return; }
  if (path === '/listen/history') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ entries: posts.filter(p => p.path === '/listen/progress').map(p => ({ ...p.data, location: { ...p.data, chapterTitle: 'Chapter one', passageIndex: Math.floor(p.data.seconds / 5), storySeconds: p.data.seconds, storyDuration: 90, excerpt: 'Saved exact text.' }, from: p.data.from && { ...p.data.from, chapterTitle: 'Chapter one' } })).reverse(), before: null })); return; }
  if (path.includes('/text/')) { if (textDelay) await new Promise(done => setTimeout(done, textDelay)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ url: 'https://www.royalroad.com/fiction/1/test', passages: Array.from({length: 18}, (_, i) => ({ id: `p${i}`, start: i * 5, end: noteMetadata && i === 17 ? 89.899999999991 : (i + 1) * 5, ...(noteMetadata && [1, 8, 16, 17].includes(i) ? {sectionKind: 'author-note'} : {}), text: `Passage ${i + 1}. ` + 'The traveler walked down the quiet road. '.repeat(8) + '\n\n' })) })); return; }
  if (path.includes('/audio/')) {
    res.setHeader('Content-Type', 'audio/wav'); res.setHeader('Accept-Ranges', 'bytes');
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), wave.length - 1) : wave.length - 1;
    if (range) { res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${wave.length}`); }
    res.setHeader('Content-Length', end - start + 1); res.end(wave.subarray(start, end + 1)); return;
  }
  const name = path === '/listen/note-output.js' ? 'note-output.js' : path === '/listen/app.js' ? 'app.js' : path === '/listen/style.css' ? 'style.css' : path === '/listen/storyteller-mark.png' ? 'storyteller-mark.png' : 'index.html';
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
  accountKey = 'notes'; offline = false; state.positions = {}; state.completed = {}; posts.length = 0; noteMetadata = true;
  book.editions.v3.chapters.push({...chapter('d'.repeat(64)), id:'two', sequence:2, title:'Chapter two'});
  const page = await browser.newPage({viewport:{width:375,height:812},reducedMotion:'reduce',colorScheme:'dark'});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/listen');
  await page.getByRole('link',{name:book.title,exact:true}).click();
  await page.getByRole('button',{name:'Listen',exact:true}).first().click();
  await page.locator('.passage').first().waitFor();
  await page.waitForFunction(()=>document.getElementById('audio').currentTime>0);
  await page.locator('#audio').evaluate(a=>{a.pause();a.currentTime=7;});
  await page.waitForFunction(()=>!document.getElementById('audio').seeking);
  await page.locator('.playback-options summary').click();
  const notes=page.getByRole('checkbox',{name:'Include author notes',exact:true});
  assert.equal(await notes.isChecked(),true,'Notes remain included by default');
  assert.equal(Math.floor(await page.locator('#audio').evaluate(a=>a.currentTime)),7);
  await notes.focus();await page.keyboard.press('Space');
  await page.waitForFunction(()=>document.getElementById('audio').currentTime===10);
  assert.equal(await notes.isChecked(),false);assert.equal(await page.locator('#audio').evaluate(a=>a.paused),true);
  assert.equal(await page.evaluate(()=>localStorage.getItem('listener:include-author-notes')),'false');
  // Record actual post-gain PCM on the audio thread, while the page thread is
  // deliberately blocked across a note boundary. Position-only tests miss leaks.
  const output = await page.evaluate(async () => {
    const guard = noteOutputGuard, ctx = guard.context;
    const code = `class NoteCapture extends AudioWorkletProcessor {process(inputs){const channel=inputs[0]?.[0];if(channel){let peak=0;for(const sample of channel)peak=Math.max(peak,Math.abs(sample));this.port.postMessage({time:currentTime,peak});}return true;}}registerProcessor('note-capture',NoteCapture);`;
    const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
    await ctx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
    const samples=[], capture=new AudioWorkletNode(ctx,'note-capture');
    capture.port.onmessage=event=>samples.push(event.data);
    guard.gain.connect(capture);capture.connect(ctx.destination);
    const a=document.getElementById('audio');a.playbackRate=2;a.currentTime=39.5;
    await new Promise(resolve=>a.addEventListener('seeked',resolve,{once:true}));
    await a.play();await new Promise(requestAnimationFrame);
    const start=ctx.currentTime, position=a.currentTime, boundary=start+(40-position)/a.playbackRate;
    const end=performance.now()+1000;while(performance.now()<end){ /* Simulate a busy/background page. */ }
    await new Promise(resolve=>setTimeout(resolve,100));a.pause();a.playbackRate=1;
    guard.gain.disconnect(capture);capture.disconnect();
    return {body:samples.filter(s=>s.time>start+.05&&s.time<boundary-.04).map(s=>s.peak),note:samples.filter(s=>s.time>boundary+.02&&s.time<boundary+.35).map(s=>s.peak)};
  });
  assert(output.body.length>10&&output.body.some(peak=>peak>.1),'Chapter content remains audible');
  assert(output.note.length>10&&output.note.every(peak=>peak<.00001),'No note samples reach output while page timers stall');

  await page.locator('#audio').evaluate(a=>a.currentTime=2);
  await page.waitForFunction(()=>!document.getElementById('audio').seeking);
  assert.equal(Math.floor(await page.locator('#audio').evaluate(a=>a.currentTime)),2,'Chapter title is ordinary content');
  await page.locator('.passage').nth(8).click();
  await page.waitForFunction(()=>document.getElementById('audio').currentTime===45);
  assert.equal(await page.locator('#audio').evaluate(a=>a.paused),true,'A note passage seek preserves pause');
  await notes.check();
  await page.locator('#audio').evaluate(a=>a.currentTime=42);
  await page.waitForFunction(()=>!document.getElementById('audio').seeking);
  assert.equal(Math.floor(await page.locator('#audio').evaluate(a=>a.currentTime)),42,'Turning notes back on restores access');
  await notes.uncheck();await page.waitForFunction(()=>document.getElementById('audio').currentTime===45);
  await page.locator('#audio').evaluate(a=>{a.currentTime=39.8;return a.play();});
  await page.waitForFunction(()=>document.getElementById('audio').currentTime>=45&&document.getElementById('audio').currentTime<47);
  await page.locator('#audio').evaluate(a=>a.pause());
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('listener:notes')).pending.length===0);
  state.positions={};
  await page.addInitScript(()=>{if(sessionStorage.getItem('notes-resume-fixture'))return;sessionStorage.setItem('notes-resume-fixture','true');const key='listener:notes',value=JSON.parse(localStorage.getItem(key));for(const row of Object.values(value.positions)){row.seconds=7;row.deviceTime=Date.now()+1000;}value.pending=[];localStorage.setItem(key,JSON.stringify(value));});
  textDelay=650;
  await page.reload();
  await page.waitForFunction(()=>document.getElementById('audio').currentTime===10);
  assert.equal(await page.locator('#include-author-notes').isChecked(),false,'Preference survives reload');
  assert.equal(await page.locator('#audio').evaluate(a=>a.paused),true,'Saved note position resumes at the body without autoplay');
  textDelay=0;
  await page.locator('#show-reading').click();
  await page.locator('#audio').evaluate(a=>a.currentTime=85);
  await page.waitForFunction(()=>document.getElementById('audio').getAttribute('src').endsWith('d'.repeat(64))&&document.getElementById('audio').readyState>0);
  await page.getByRole('heading',{name:'Chapter two',exact:true}).waitFor();
  assert.equal(await page.locator('#audio').evaluate(a=>a.paused),true,'Skipping ending notes preserves pause in next chapter');
  assert.equal(posts.filter(p=>p.data.assembly==='a'.repeat(64)&&p.data.completed).length,1,'Ending-note skip completes the chapter once');
  await page.locator('#audio').evaluate(a=>{a.currentTime=85;a.play().catch(()=>{});});
  await page.waitForFunction(()=>document.getElementById('audio').currentTime===90&&document.getElementById('audio').paused);
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('listener:notes')).pending.length===0);
  assert.equal(state.completed['fixture:two'],true,'Ending notes of the final chapter complete without a loop');
  const completions=()=>posts.filter(p=>p.data.assembly==='d'.repeat(64)&&p.data.completed).length;
  assert.equal(completions(),1);
  await page.locator('#audio').evaluate(a=>a.currentTime=30);
  await page.waitForFunction(()=>!document.getElementById('audio').seeking);
  await page.locator('#audio').evaluate(a=>a.currentTime=85);
  await page.waitForFunction(()=>document.getElementById('audio').currentTime===90&&!document.getElementById('audio').seeking);
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('listener:notes')).pending.length===0);
  assert.equal(completions(),2,'An explicit backwards story seek permits a later completion');
  assert.deepEqual(errors,[]);
  await page.locator('.playback-options summary').click();
  await notes.focus();
  let bounds=await notes.boundingBox();assert(bounds&&bounds.y>=0&&bounds.y+bounds.height<=812);
  if(process.env.SCREENSHOTS)await page.screenshot({path:process.env.SCREENSHOTS+'/listener-author-notes-375.png',fullPage:true});
  await page.setViewportSize({width:667,height:375});
  await page.addStyleTag({content:'.checkbox-option{font-size:26px}'});
  await notes.scrollIntoViewIfNeeded();await notes.focus();
  bounds=await notes.boundingBox();assert(bounds&&bounds.y>=0&&bounds.y+bounds.height<=375,'Large-text checkbox stays reachable in landscape');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(process.env.SCREENSHOTS)await page.screenshot({path:process.env.SCREENSHOTS+'/listener-author-notes-landscape-large.png',fullPage:true});
  await page.close();
  state.positions={};state.completed={};posts.length=0;
  const slow=await browser.newPage({viewport:{width:320,height:740},reducedMotion:'reduce'});
  await slow.addInitScript(()=>localStorage.setItem('listener:include-author-notes','false'));
  textDelay=700;
  await slow.goto(base+'/listen');await slow.getByRole('link',{name:book.title,exact:true}).click();
  await slow.getByRole('button',{name:'Listen',exact:true}).first().click();
  await slow.waitForFunction(()=>document.getElementById('audio').readyState>0);
  assert.equal(await slow.locator('#audio').evaluate(a=>a.paused),true,'Autoplay waits for section metadata');
  await slow.waitForFunction(()=>document.getElementById('audio').currentTime>0);
  assert.equal(await slow.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await slow.close();
  state.positions={};textDelay=3000;
  const included=await browser.newPage();
  await included.goto(base+'/listen');await included.getByRole('link',{name:book.title,exact:true}).click();
  await included.getByRole('button',{name:'Listen',exact:true}).first().click();
  await included.waitForFunction(()=>document.getElementById('audio').currentTime>0&&document.querySelectorAll('.passage').length===0,undefined,{timeout:2000});
  await included.close();
  textDelay=0;noteMetadata=false;
  state.positions={'fixture:v3:one':{story:'fixture',edition:'v3',assembly:'a'.repeat(64),seconds:7,deviceTime:Date.now()}};
  const legacy=await browser.newPage();
  await legacy.addInitScript(()=>localStorage.setItem('listener:include-author-notes','false'));
  await legacy.goto(base+'/listen');await legacy.waitForFunction(()=>document.getElementById('audio').currentTime===7);
  assert.equal(await legacy.locator('#audio').evaluate(a=>a.paused),true,'Unknown legacy sections are included');
  await legacy.close();
  state.positions={};textDelay=15000;
  const stalled=await browser.newPage();
  await stalled.addInitScript(()=>localStorage.setItem('listener:include-author-notes','false'));
  await stalled.goto(base+'/listen');await stalled.getByRole('link',{name:book.title,exact:true}).click();
  await stalled.getByRole('button',{name:'Listen',exact:true}).first().click();
  await stalled.waitForFunction(()=>document.getElementById('audio').currentTime>0,undefined,{timeout:13000});
  await stalled.getByText('Author-note timings are unavailable. Playing the full chapter.',{exact:true}).waitFor();
  await stalled.close();textDelay=0;
  console.log('PASS: optional author notes, keyboard/persistence, source-safe seeks, delayed metadata and chapter completion');
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
