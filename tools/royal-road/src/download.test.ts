import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fictionUrl, parseFiction, parseChapter, hash } from './pages.js';
import { sync } from './download.js';
import { requests, publicAddress, imageUrl, retryDelay } from './network.js';
import { extractChapter } from './pages.js';
const url = 'https://www.royalroad.com/fiction/42/sample';
const toc = (ids = [90, 12]) => `<h1>Sample</h1><table id="chapters" data-chapters="${ids.length}"><tbody>${ids.map(id => `<tr><td><a href="/fiction/42/sample/chapter/${id}/title">Chapter ${id}</a></td></tr>`).join('')}</tbody></table>`;
const html = (text = 'First &amp; second.') => `<h1>A chapter</h1><style>.hidden-random { display: none; speak: never; }</style><div class="author-note">Note</div><div class="chapter-content"><p>${text}<span class="hidden-random">Hidden injection</span></p><p>“Dialogue.”<br>Next line.</p><hr><table><tr><td>Power</td><td>12</td></tr></table></div><div>Comments</div>`;
test('TOC order and visible paragraphs, lines, tables and scenes', () => {
  const fiction = parseFiction(toc(), url);
  assert.deepEqual(fiction.chapters.map(c => c.chapterId), ['rr-90', 'rr-12']);
  const chapter = parseChapter(html(), fiction.fictionId, fiction.chapters[0]!);
  assert.equal(chapter.text, 'First & second.\n\n“Dialogue.”\nNext line.\n\n* * *\n\nPower\t12');
  assert.equal(chapter.contentHash, hash(chapter.text));
});
test('rejects foreign URLs, login/challenge pages, incomplete TOCs and wrong chapters', () => {
  assert.throws(() => fictionUrl('https://evil.test/fiction/42/sample'));
  assert.throws(() => fictionUrl(url + '/chapter/1/title'));
  assert.throws(() => parseFiction('<title>Just a moment</title>', url));
  assert.throws(() => parseFiction(toc().replace('data-chapters="2"', 'data-chapters="3"'), url));
  assert.throws(() => parseFiction(toc([90, 90]), url));
  const link = parseFiction(toc(), url).chapters[0]!;
  assert.throws(() => parseChapter('<input type="password">', 'rr-42', link));
  assert.throws(() => parseChapter('<link rel="canonical" href="/fiction/42/sample/chapter/99/title">' + html(), 'rr-42', link));
});
test('resumes failed downloads, skips saved chapters and preserves old revisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rr-test-'));
  try {
    let fail = true, gets = 0, text = 'Original';
    const get = async (page: string) => { if (!page.includes('/chapter/')) return toc(); gets++; if (fail && page.includes('/12/')) throw new Error('HTTP 429'); return html(text); };
    await assert.rejects(sync(root, url, get), /429/);
    await assert.rejects(readFile(join(root, 'rr-42/chapters.json')), /ENOENT/);
    fail = false; gets = 0;
    const resumed = await sync(root, url, get);
    assert.equal(gets, 1); assert.equal(resumed.reused, 1); assert.equal(resumed.complete, true);
    gets = 0; await sync(root, url, get); assert.equal(gets, 0);
    const oldManifest = JSON.parse(await readFile(join(root, 'rr-42/manifest.json'), 'utf8'));
    text = 'Changed'; await sync(root, url, get, { refresh: true });
    const chapters = JSON.parse(await readFile(join(root, 'rr-42/chapters.json'), 'utf8'));
    assert.match(chapters[0].text, /Changed/);
    const old = JSON.parse(await readFile(join(root, 'rr-42/revisions', `${oldManifest.current['rr-90']}.json`), 'utf8'));
    assert.match(old.text, /Original/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('ranges preserve positions; changed TOC order preserves archive order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rr-range-'));
  try {
    let ids = [90, 12]; const get = async (page: string) => page.includes('/chapter/') ? html() : toc(ids);
    assert.equal((await sync(root, url, get, { from: 2, to: 2 })).complete, false);
    let chapters = JSON.parse(await readFile(join(root, 'rr-42/chapters.json'), 'utf8'));
    assert.equal(chapters[0].sequence, 2);
    await sync(root, url, get); ids = [12, 90]; await sync(root, url, get);
    chapters = JSON.parse(await readFile(join(root, 'rr-42/chapters.json'), 'utf8'));
    assert.deepEqual(chapters.map((c: {chapterId: string}) => c.chapterId), ['rr-90', 'rr-12']);
    assert.equal(chapters[0].sequence, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('rejects concurrent writers and corrupt saved revisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rr-integrity-'));
  try {
    const get = async (page: string) => page.includes('/chapter/') ? html() : toc();
    await sync(root, url, get); const directory = join(root, 'rr-42');
    await writeFile(join(directory, 'writer.lock'), 'other');
    await assert.rejects(sync(root, url, get), /locked/); await rm(join(directory, 'writer.lock'));
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    const file = join(directory, 'revisions', `${manifest.current['rr-90']}.json`);
    const chapter = JSON.parse(await readFile(file, 'utf8')); chapter.text = 'corrupt'; await writeFile(file, JSON.stringify(chapter));
    await assert.rejects(sync(root, url, get), /integrity/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('HTTP bounds retries, respects cooldown and rejects private image destinations', async () => {
  let calls = 0; const waits: number[] = [];
  const get = requests({ intervalMs: 0, sleep: async ms => { waits.push(ms); }, request: async () => { calls++; return calls < 3 ? new Response('',{status:429,headers:{'retry-after':'2'}}) : new Response('<html>ok</html>',{headers:{'content-type':'text/html'}}); } });
  assert.match((await get(url)).bytes.toString(), /ok/); assert.equal(calls,3); assert.equal(waits.filter(n=>n===2000).length,2);
  await assert.rejects(requests({intervalMs:0,sleep:async()=>{},request:async()=>new Response('',{status:429,headers:{'retry-after':'3600'}})})(url), /longer cooldown/);
  await assert.rejects(requests({intervalMs:0,request:async()=>new Response('',{status:302,headers:{location:'https://evil.test/'}})})(url), /royalroad.com/);
  assert.equal(publicAddress('127.0.0.1'),false); assert.equal(publicAddress('10.0.0.1'),false); assert.equal(publicAddress('::ffff:127.0.0.1'),false);
  assert.throws(()=>imageUrl('https://169.254.169.254/latest')); assert.throws(()=>imageUrl('file:///secret'));
  assert.equal(retryDelay('Wed, 01 Jan 2020 00:00:05 GMT',Date.parse('2020-01-01T00:00:00Z')),5000);
  const binaryImage = await requests({intervalMs:0,request:async()=>new Response('GIF89a',{headers:{'content-type':'application/octet-stream'}})})(url,true);
  assert.equal(binaryImage.bytes.toString(),'GIF89a');
  await assert.rejects(requests({intervalMs:0,request:async()=>new Response('<html>Error</html>',{headers:{'content-type':'text/html'}})})(url,true), /Expected an image/);
});
test('preserves collapsed content and tables, captures images and strips active HTML', () => {
 const link=parseFiction(toc(),url).chapters[0]!;
 const record=extractChapter(`<h1>Test</h1><div class="chapter-content"><p>Before.</p><div class="spoiler"><div class="smalltext">Stats</div><div class="spoiler-inner" style="display:none"><p>Strength: 12</p><img data-src="https://cdn.example.org/a.png" alt="Portrait" onerror="alert(1)"></div></div><script>alert(1)</script><a href="javascript:alert(1)">Link</a></div>`,'rr-42',link);
 assert.match(record.chapter.text,/Strength: 12/); assert.match(record.html,/<details open/); assert.doesNotMatch(record.html,/onerror|javascript:|<script/);
 assert.equal(record.images[0]?.url,'https://cdn.example.org/a.png'); assert.equal(record.images[0]?.alt,'Portrait');
});
test('structured chapters track locked content and short chapter URLs', () => {
 const page='<h1>New design</h1><script>window.chapters = '+JSON.stringify([{id:90,title:'Open',url:'/fiction/chapter/90',isUnlocked:true},{id:12,title:'Locked',url:'/fiction/chapter/12',isUnlocked:false}])+';</script>';
 const fiction=parseFiction(page,url); assert.equal(fiction.chapters[1]?.availability,'locked'); assert.equal(fiction.chapters[0]?.chapterId,'rr-90');
});
test('removed chapters stay in export; local HTML reprocessing downloads no chapter pages',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rr-archive-'));
 try {
  let ids=[90,12], gets=0;
  const get=async(page:string)=>{ if(!page.includes('/chapter/'))return toc(ids);gets++;return html(); };
  await sync(root,url,get); ids=[12]; gets=0;
  const result=await sync(root,url,get,{reprocess:true}); assert.equal(gets,0); assert.equal(result.removed,1); assert.equal(result.saved,2);
  const data=JSON.parse(await readFile(join(root,'rr-42/chapters.json'),'utf8')); assert.deepEqual(data.map((c:{chapterId:string})=>c.chapterId),['rr-90','rr-12']);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('stores image bytes with checksums and records failures without dropping story text',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rr-images-'));
 try {
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,1]);
  const get=async(page:string)=>page.includes('/chapter/')?html('Story <img src="https://example.org/a.png"><img src="https://example.org/b.png">'):toc([90]);
  const result=await sync(root,url,get,{getImage:async(src)=>{if(src.endsWith('b.png'))throw new Error('HTTP 404');return {bytes,mime:'image/png'};}});
  assert.equal(result.mediaErrors,1);assert.equal(result.complete,true);
  assert.deepEqual(await readFile(join(root,'rr-42/assets',hash(bytes))),bytes);
  const manifest=JSON.parse(await readFile(join(root,'rr-42/manifest.json'),'utf8'));
  const record=JSON.parse(await readFile(join(root,'rr-42/records',manifest.details['rr-90']+'.json'),'utf8'));
  assert.equal(record.images[1].error,'HTTP 404');assert.match(record.chapter.text,/Story/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('new layout uses JSON-LD title and author',()=>{
 const page='<h1>Royal Road</h1><script type="application/ld+json">{"name":"Actual book","author":{"name":"Writer"},"description":"<p>About the book</p>","image":"https://example.com/cover.png"}</script><script>window.chapters = [{"id":90,"title":"Open","url":"/fiction/chapter/90","isUnlocked":true}];</script>';
 const book=parseFiction(page,url);assert.equal(book.title,'Actual book');assert.equal(book.author,'Writer');assert.equal(book.description,'About the book');
});
test('legacy downloaded text becomes a browsable earlier version',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rr-migration-'));
 try{
  const get=async(page:string)=>page.includes('/chapter/')?html():toc([90]);
  await sync(root,url,get);
  const path=join(root,'rr-42/manifest.json');const m=JSON.parse(await readFile(path,'utf8'));
  delete m.details;delete m.history;delete m.archive;m.schemaVersion=1;await writeFile(path,JSON.stringify(m));
  await sync(root,url,get);
  const migrated=JSON.parse(await readFile(path,'utf8'));assert.equal(migrated.history['rr-90'].length,2);
  const old=JSON.parse(await readFile(join(root,'rr-42/records',migrated.history['rr-90'][0]+'.json'),'utf8'));
  assert.equal(old.sourceHash,'');assert.match(old.chapter.text,/First & second/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('cancellation keeps completed revisions and releases the writer for a later resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rr-cancel-')), abort = new AbortController();
  try {
    let downloaded = 0;
    await assert.rejects(sync(root, url, async page => {
      if (!page.includes('/chapter/')) return toc();
      downloaded++; abort.abort(); return html();
    }, { signal: abort.signal }), /abort/i);
    assert.equal(downloaded, 1);
    const result = await sync(root, url, async page => page.includes('/chapter/') ? html() : toc());
    assert.equal(result.reused, 1); assert.equal(result.downloaded, 1); assert.equal(result.complete, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancellation releases the archive lock and keeps completed chapter checkpoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rr-cancel-'));
  const controller = new AbortController();
  const fiction = '<h1>Story</h1><table id="chapters"><tbody><tr><td><a href="/fiction/42/story/chapter/10/one">One</a></td></tr><tr><td><a href="/fiction/42/story/chapter/20/two">Two</a></td></tr></tbody></table>';
  try {
    await assert.rejects(sync(root,'42',async url=>{
      if(!url.includes('/chapter/'))return fiction;
      controller.abort();
      return '<div class="chapter-content"><p>Saved before shutdown.</p></div>';
    },{signal:controller.signal}),/abort/i);
    const manifest=JSON.parse(await readFile(join(root,'rr-42/manifest.json'),'utf8'));
    assert.equal(Object.keys(manifest.current).length,1);
    await assert.rejects(readFile(join(root,'rr-42/writer.lock')), {code:'ENOENT'});
  } finally { await rm(root,{recursive:true,force:true}); }
});
