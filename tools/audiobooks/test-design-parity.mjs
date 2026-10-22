import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// These are fictional review fixtures, isolated from every production endpoint.
const fixture = JSON.parse(await readFile(new URL('./test-fixtures/listener-design.json', import.meta.url)));
const hash = text => createHash('sha256').update(text).digest('hex');
const data=structuredClone(fixture.api.library),books=data.books,texts=new Map(Object.entries(fixture.api.readings));
const selected=books[0], chapter=selected.editions.v3.chapters[11], point=data.state.positions[`${selected.id}:v3:${chapter.id}`];
const catalog=structuredClone(fixture.api.catalog);
for(const story of catalog.stories)story.hasCover=!!process.env.DESIGN_COVERS;
const wave=Buffer.alloc(44+8000*2*1460);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(8000,24);wave.writeUInt32LE(16000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(wave.length-44,40);
let scenario = '', libraryGate;
const server=createServer(async(req,res)=>{
  try {
    const path=new URL(req.url,'http://localhost').pathname;
    const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
    if(req.method==='POST' && scenario==='mutation-failure'){res.statusCode=503;return json({error:'Couldn’t save. Your choices are still here. Try again.'});}
    if(req.method==='POST') { const chunks=[];for await(const chunk of req)chunks.push(chunk);const value=JSON.parse(Buffer.concat(chunks)); if(path.endsWith('/resolve'))data.state.issues.find(i=>i.id===value.id).status=value.resolved?'resolved':'open';json({});return; }
    if(path.endsWith('/library')) {
      if(libraryGate)await libraryGate;
      if(scenario==='library-error'){res.statusCode=503;return json({error:'Library service unavailable.'});}
      if(scenario==='library-empty')return json({...data,books:[],state:{positions:{},completed:{},seen:{},issues:[]}});
      if(scenario==='chapter-unavailable'){const alternate=structuredClone(data),book=alternate.books[0],current=book.editions.qwen.chapters[10];book.editions.qwen.chapters=book.editions.qwen.chapters.filter(c=>c.sequence!==12);alternate.state.positions={qwen:{story:book.id,edition:'qwen',assembly:current.assembly,seconds:184,deviceTime:Date.now()}};return json(alternate);}
      return json(data);
    }
    if(path.endsWith('/capabilities'))return json({accountLabel:'reader@example.test',permissions:{listen:true,manageLibrary:scenario!=='view-only',generate:scenario!=='view-only'}});
    if(path.endsWith('/catalog')){if(scenario==='library-empty')return json({stories:[],jobs:[]});const value=structuredClone(catalog);if(scenario==='preparation-unsupported')value.stories.find(b=>b.id==='orchard').supported=false;return json(value);}
    if(path.endsWith('/history'))return json({entries:scenario==='history-empty'?[]:fixture.api.history,before:null});
    if(path.includes('/text/')){if(scenario==='edition-failure'&&path.includes('/qwen/')){res.statusCode=503;return json({error:'This passage is unavailable in that edition. Your place is kept.'});}return json(texts.get(path.split('/').at(-1)));}
    if(path.endsWith('/cover') && process.env.DESIGN_COVERS) { res.setHeader('Content-Type','image/png');res.end(await readFile(join(process.env.DESIGN_COVERS,path.split('/').at(-2)+'.png')));return; }
    if(path.includes('/audio/')) {const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||''),start=range?Number(range[1]):0,end=range?.[2]?Math.min(Number(range[2]),wave.length-1):wave.length-1;res.setHeader('Content-Type','audio/wav');res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Length',end-start+1);if(range){res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${wave.length}`);}res.end(wave.subarray(start,end+1));return;}
    const name=path.split('/').at(-1),file=['app.js','icons.js','chapter-view.js','note-output.js','style.css','storyteller-mark.png'].includes(name)?name:'index.html';
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/html');res.end(await readFile(new URL('./listener-web/'+file,import.meta.url)));
  } catch(error) {res.statusCode=500;res.end(JSON.stringify({error:error.message}));}
});
await new Promise(resolve=>server.listen(Number(process.env.DESIGN_PORT||0),'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
if(process.env.DESIGN_SERVE) {console.log(`Fictional design review: ${base}/listen`);}
else {
  const browser=await chromium.launch({headless:true}), output=process.env.SCREENSHOTS;
  const evidence=[];
  try {
    if(output)await mkdir(output,{recursive:true});
    for(const profile of [{name:'phone',width:390,height:844},{name:'narrow-large',width:320,height:900,scale:2},{name:'landscape-large',width:844,height:390,scale:2},{name:'expanded-dark',width:840,height:900,dark:true},{name:'wide',width:1440,height:900}]) {
      const page=await browser.newPage({viewport:{width:profile.width,height:profile.height},colorScheme:profile.dark?'dark':'light',reducedMotion:'reduce'}),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      if(profile.scale)await page.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{document.documentElement.style.fontSize='200%';}));
      const capture=async name=>{
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${profile.name}/${name} page overflow`);
        for(const selector of ['dialog[open]','.playback-dock','.masthead']) {const node=page.locator(selector);if(await node.isVisible())assert.equal(await node.evaluate(e=>e.scrollWidth>e.clientWidth+1),false,`${profile.name}/${name}: ${selector} overflow`);}
        if(output){const file=`web-${profile.name}-${name}.png`;await page.screenshot({path:join(output,file)});if(await page.locator('dialog[open]').count())await page.locator('dialog[open]').screenshot({path:join(output,file.replace('.png','-sheet.png'))});evidence.push({profile:profile.name,screen:name,file,sha256:hash(await readFile(join(output,file)))});}
      };
      await page.goto(base+'/listen');await page.getByRole('link',{name:selected.title,exact:true}).waitFor();await page.waitForFunction(()=>document.getElementById('audio').readyState>0&&document.getElementById('audio').currentTime===496);await capture('01-library');
      await page.getByRole('button',{name:'In progress',exact:true}).click();await page.getByRole('link',{name:selected.title,exact:true}).click();await capture('02-book');
      await page.getByRole('button',{name:'Chapters',exact:true}).click();await capture('03-chapters');
      await page.getByRole('button',{name:chapter.title,exact:true}).click();await page.locator('.passage').first().waitFor();await capture('04-browsing');
      assert.equal(await page.locator('#audio').evaluate(e=>e.paused),true);
      const originalAudio=await page.locator('#audio').getAttribute('src');
      await page.getByRole('button',{name:'Next chapter',exact:true}).click();await page.getByRole('heading',{name:'Out past the harbour',exact:true}).waitFor();await capture('04-browsing-next');
      assert.equal(await page.locator('#audio').getAttribute('src'),originalAudio);assert.equal(await page.locator('#audio').evaluate(e=>e.currentTime),496);
      assert.equal(await page.locator('#passages').evaluate(e=>e.scrollTop),0,'Adjacent text opens at its beginning');
      await page.locator('#follow').click();await capture('05-listening');
      await page.locator('#toggle').click();await page.getByRole('button',{name:'Pause',exact:true}).waitFor();await capture('state-listening-playing');
      await page.locator('#back').click();await page.getByRole('button',{name:'Undo jump',exact:true}).waitFor();await capture('state-listening-playing-with-undo');
      await page.locator('#toggle').click();await page.getByRole('button',{name:'Play',exact:true}).waitFor();await page.locator('#undo').click();
      await page.waitForFunction(()=>document.querySelector('#audio').currentTime>=496);
      await page.locator('#audio-output').click();await capture('05-audio-output');await page.locator('#output-dialog [data-close]').click();
      await page.locator('#settings').click();await capture('06-settings');await page.locator('#listening-settings [data-close]').click();
      await page.locator('#open-speed').click();await capture('07-speed');await page.getByLabel('Custom speed',{exact:true}).fill('9');await page.getByRole('button',{name:'Apply speed',exact:true}).click();assert.equal(await page.locator('#speed-error').isVisible(),true);await capture('08-speed-invalid');
      await page.getByLabel('Custom speed',{exact:true}).fill('1.35');await page.getByRole('button',{name:'Apply speed',exact:true}).click();assert.equal(await page.locator('#audio').evaluate(e=>e.playbackRate),1.35);
      await page.locator('#open-history').click();await page.locator('.jump-return').first().waitFor();await capture('09-jumps');await page.locator('#history-dialog [data-close]').click();
      await page.locator('#mark-issue').click();await capture('10-mark-issue');await page.locator('#discard-issue').click();
      await page.goto(base+'/listen#story/lighthouse');await page.getByRole('button',{name:'Marked issues',exact:true}).waitFor();await page.getByRole('button',{name:'Marked issues',exact:true}).click();await capture('11-issues');
      await page.goto(base+'/listen#preparation/orchard');await page.getByRole('heading',{name:'Preparing audio',exact:true}).waitFor();await capture('12-preparation');
      await page.locator('#settings').click();await capture('13-preparation-settings');
      // Closing a sheet and choosing the next page in the same frame must preserve Back.
      await page.evaluate(()=>{document.querySelector('#preparation-settings [data-close]').click();document.querySelector('#account').click();});
      await page.getByRole('heading',{name:'Your account',exact:true}).waitFor();
      await page.locator('#nav-back').click();await page.getByRole('heading',{name:'Preparing audio',exact:true}).waitFor();assert.equal(await page.locator('dialog[open]').count(),0, 'Back after rapid sheet close must not reopen settings');
      await page.locator('#account').click();await page.getByRole('heading',{name:'Your account',exact:true}).waitFor();await capture('14-account');
      assert.deepEqual(errors,[],`${profile.name} script errors`);await page.close();console.log(`PASS: all approved web screens at ${profile.name}`);
    }
    for(const profile of [{name:'phone',width:390,height:844},{name:'narrow-large',width:320,height:900,scale:2},{name:'expanded-dark',width:840,height:900,dark:true}]) {
      const errors=[];
      const fresh=async hash=>{
        const page=await browser.newPage({viewport:{width:profile.width,height:profile.height},colorScheme:profile.dark?'dark':'light',reducedMotion:'reduce'});
        page.on('pageerror',error=>errors.push(error.message));
        if(profile.scale)await page.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{document.documentElement.style.fontSize='200%';}));
        await page.goto(base+'/listen'+(hash||''));return page;
      };
      const capture=async(page,name)=>{
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${profile.name}/${name} overflow`);
        if(output){const file=`web-${profile.name}-${name}.png`;await page.screenshot({path:join(output,file)});if(await page.locator('dialog[open]').count())await page.locator('dialog[open]').screenshot({path:join(output,file.replace('.png','-sheet.png'))});evidence.push({profile:profile.name,screen:name,file,sha256:hash(await readFile(join(output,file)))});}
      };
      let release;libraryGate=new Promise(resolve=>{release=resolve;});
      let page=await fresh();await page.locator('.loading-books').waitFor();await capture(page,'state-library-loading');release();libraryGate=undefined;await page.waitForFunction(()=>document.getElementById('audio').readyState>0);await page.close();
      scenario='library-empty';page=await fresh();await page.getByRole('heading',{name:'No books yet',exact:true}).waitFor();await capture(page,'state-library-empty');await page.close();
      scenario='';page=await fresh();await page.waitForFunction(()=>document.getElementById('audio').readyState>0);
      await page.getByLabel('Find a book').fill('No matching story');await capture(page,'state-library-no-results');await page.getByRole('button',{name:'Show all books',exact:true}).click();
      scenario='library-error';await page.locator('#refresh').click();await page.locator('#library-notice').getByRole('button',{name:'Retry',exact:true}).waitFor();assert.equal(await page.getByRole('link',{name:selected.title,exact:true}).isVisible(),true);await capture(page,'state-library-refresh-failure');
      scenario='';await page.locator('#library-notice').getByRole('button',{name:'Retry',exact:true}).click();await page.waitForFunction(()=>document.getElementById('library-notice').textContent==='');
      await page.context().setOffline(true);await page.getByText('Offline. Showing your saved library.',{exact:true}).waitFor();await capture(page,'state-library-offline');await page.context().setOffline(false);await page.close();
      scenario='chapter-unavailable';page=await fresh('#chapters/lighthouse');await page.getByLabel('Find a chapter').fill('12');await capture(page,'state-chapter-unavailable');assert.equal(await page.getByRole('button',{name:'Play '+chapter.title,exact:true}).isEnabled(),false);await page.close();
      scenario='';page=await fresh('#reading');await page.waitForFunction(()=>document.getElementById('audio').readyState>0&&document.getElementById('audio').currentTime===496);
      await page.locator('#settings').click();scenario='edition-failure';await page.locator('#edition-choices').getByRole('button',{name:'Qwen local',exact:true}).click();await page.locator('#edition-error').getByText('This passage is unavailable in that edition. Your place is kept.',{exact:true}).waitFor();await capture(page,'state-edition-failure');assert.equal(await page.locator('#audio').evaluate(e=>e.currentTime),496);await page.locator('#listening-settings [data-close]').click();
      scenario='history-empty';await page.locator('#open-history').click();await page.getByRole('heading',{name:'No jumps yet',exact:true}).waitFor();await capture(page,'state-jumps-empty');await page.locator('#history-dialog [data-close]').click();
      scenario='';await page.locator('#open-history').click();await page.locator('.jump-return').first().waitFor();await page.context().setOffline(true);await page.locator('#history-dialog [data-close]').click();await page.locator('#open-history').click();await capture(page,'state-jumps-offline');await page.locator('#history-dialog [data-close]').click();await page.context().setOffline(false);
      await page.locator('#mark-issue').click();await page.getByLabel('Optional note',{exact:true}).fill('Keep this draft after a failed save.');
      await page.evaluate(()=>{window.reviewOriginalSetItem=Storage.prototype.setItem;window.reviewStorageWrites=0;Storage.prototype.setItem=function(key,value){if(key.startsWith('listener:')&&++window.reviewStorageWrites>=2)throw new DOMException('Fixture quota exhausted','QuotaExceededError');return window.reviewOriginalSetItem.call(this,key,value);};});
      await page.getByRole('button',{name:'Save issue',exact:true}).click();await page.locator('#issue-error').getByText('Couldn’t save here. Your draft is kept. Free some storage and try again.',{exact:true}).waitFor();await capture(page,'state-issue-save-failure');assert.equal(await page.getByLabel('Optional note',{exact:true}).inputValue(),'Keep this draft after a failed save.');assert.equal(await page.evaluate(()=>local.issueQueue.length),0,'A failed durable save must not leave a queued report to send later');
      await page.locator('#cancel-issue').click();assert.equal(await page.locator('#issue-dialog').isVisible(),true,'A failed draft write keeps the form open');
      await page.evaluate(()=>{Storage.prototype.setItem=window.reviewOriginalSetItem;});await page.locator('#discard-issue').click();await page.close();
      scenario='';page=await fresh('#issues');await page.getByRole('button',{name:'Resolve issue',exact:true}).first().waitFor();await page.context().setOffline(true);await capture(page,'state-issues-offline');await page.close();
      scenario='view-only';page=await fresh('#issues');await page.getByText('You can view reports. Updating them requires library access.',{exact:true}).waitFor();await capture(page,'state-issues-view-only');await page.close();
      scenario='';page=await fresh('#preparation/orchard');await page.getByRole('heading',{name:'Preparing audio',exact:true}).waitFor();
      const job=catalog.jobs.find(job=>job.story==='orchard');
      for(const status of ['queued','running','publishing','waiting','failed','cancelled','complete']){job.status=status==='publishing'?'running':status;job.phase=status==='publishing'?'Publishing audio.':'Working on chapter 7.';job.cancel=false;await page.getByRole('button',{name:'Refresh status',exact:true}).click();await page.getByText('6 of 24 chapters published',{exact:true}).waitFor();await capture(page,'state-preparation-'+status);}
      job.status='running';job.cancel=true;await page.getByRole('button',{name:'Refresh status',exact:true}).click();await page.getByRole('heading',{name:'Cancellation requested',exact:true}).waitFor();await capture(page,'state-preparation-cancellation-requested');await page.context().setOffline(true);await capture(page,'state-preparation-offline');await page.close();
      scenario='preparation-unsupported';page=await fresh('#preparation/orchard');await page.getByText('Audio preparation is not available for this source.',{exact:true}).waitFor();await capture(page,'state-preparation-unsupported');await page.close();
      scenario='';job.cancel=false;page=await fresh('#preparation/orchard');await page.getByRole('heading',{name:'Preparing audio',exact:true}).waitFor();await page.locator('#settings').click();await page.getByLabel('Automatic checks',{exact:true}).uncheck();scenario='mutation-failure';await page.getByRole('button',{name:'Save settings',exact:true}).click();await page.getByText('Couldn’t save. Your choices are still here. Try again.',{exact:true}).waitFor();await capture(page,'state-preparation-settings-save-failure');assert.equal(await page.getByLabel('Automatic checks',{exact:true}).isChecked(),false);await page.close();
      scenario='';assert.deepEqual(errors,[],`${profile.name} recovery script errors`);console.log(`PASS: web loading, offline, permissions, failure and preparation states at ${profile.name}`);
    }
    if(output)await writeFile(join(output,'web-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
  } finally {await browser.close();server.close();}
}
