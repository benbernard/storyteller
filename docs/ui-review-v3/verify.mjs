import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
const require=createRequire(new URL('../../tools/audiobooks/package.json',import.meta.url));
const {chromium}=require('@playwright/test');
const output=resolve(process.argv[2]??'.agent-scratch/ui-review-v3');
const html=await fs.readFile(join(output,'storyteller-design-review-v3.html'));
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});
const records=[];
const luminance=value=>{const hex=value.length===4?'#'+[...value.slice(1)].map(c=>c+c).join(''):value;const rgb=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];};
const ratio=(a,b)=>{const values=[luminance(a),luminance(b)].sort((a,b)=>a-b);return (values[1]+.05)/(values[0]+.05);};
try{
 for(const concept of ['dock','split','stage','journey'])for(const width of [375,1280]){
  const page=await browser.newPage({viewport:{width,height:1800},reducedMotion:'reduce'});page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  console.log('render',concept,width);await page.goto(`${base}/#${concept}${width===1280?'?desktop':''}`);let frame=page.frameLocator('#prototype');await frame.locator('body button').first().waitFor();
  for(const alternate of [false,true]){
   if(alternate)await page.locator('#appearance').click();
   await frame.locator('body button').first().waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'host overflow');
   assert.equal(await frame.locator('body').evaluate(el=>el.ownerDocument.documentElement.scrollWidth>el.ownerDocument.defaultView.innerWidth),false,concept+' overflow');
   const palette=await frame.locator('body').evaluate(el=>{const s=getComputedStyle(el);return Object.fromEntries(['bg','surface','ink','muted','soft','accent','on'].map(k=>[k,s.getPropertyValue('--'+k).trim()]));});
   for(const fg of ['ink','muted'])for(const bg of ['bg','surface','soft'])assert.ok(ratio(palette[fg],palette[bg])>=4.5,`${concept} ${fg}/${bg} contrast ${ratio(palette[fg],palette[bg])}`);
   assert.ok(ratio(palette.on,palette.accent)>=4.5,`${concept} button contrast`);
   records.push({concept,width,alternate,overflow:false,textContrast:true});
   if(!alternate)await page.locator('#prototype').screenshot({path:join(output,`${concept}-home-${width}.png`)});
  }
  await page.locator('#appearance').click();
  const action={dock:'focus',split:'focus',stage:'library',journey:'chapter-13'}[concept];
  await frame.locator(`[data-action="${action}"]`).first().click();
  await frame.getByText({dock:'Listening deck',split:'Listening deck',stage:'Your books',journey:'Out past the harbour'}[concept],{exact:true}).first().waitFor();
  await page.locator('#prototype').screenshot({path:join(output,`${concept}-detail-${width}.png`)});
  assert.equal(await frame.locator('body').evaluate(el=>el.ownerDocument.documentElement.scrollWidth>el.ownerDocument.defaultView.innerWidth),false,concept+' detail overflow');
  assert.deepEqual(errors,[]);await page.close();
 }
 const page=await browser.newPage({viewport:{width:1000,height:1800},reducedMotion:'reduce'});page.setDefaultTimeout(15000);
 await page.goto(`${base}/#dock`);let frame=page.frameLocator('#prototype');
 await frame.locator('[data-action="open-0"]').click();await frame.locator('[data-action="detail-play-13"]').click();await frame.getByText('13 · Out past the harbour',{exact:true}).waitFor();await frame.locator('#dialog').getByRole('button',{name:'Pause',exact:true}).waitFor();await frame.getByRole('button',{name:'Close',exact:true}).click();
 await frame.getByRole('button',{name:'Playback preferences',exact:true}).click();await frame.locator('[data-field="notes"]').uncheck();await frame.getByRole('button',{name:'Close',exact:true}).click();await frame.locator('[data-action="focus"]').click();await frame.getByRole('button',{name:'Read along',exact:true}).click();assert.equal(await frame.locator('.note').count(),0);await frame.getByRole('button',{name:'Close',exact:true}).click();
 console.log('flow split');await page.locator('[data-concept="split"]').click();frame=page.frameLocator('#prototype');await frame.locator('[data-action="select-1"]').click();await frame.locator('.selected-story h2').filter({hasText:'An Atlas of Lost Tides'}).waitFor();await frame.locator('#book-search').fill('not a book');await frame.getByText('No matching books. Try another title or author.').waitFor();await frame.locator('#book-search').fill('');await frame.locator('[data-action="focus"]').click();await frame.locator('#dialog').getByRole('button',{name:'Forward 30 seconds'}).click();await frame.locator('#dialog [data-time]').filter({hasText:'0:30'}).waitFor();await frame.getByRole('button',{name:'Close',exact:true}).click();
 console.log('flow stage');await page.locator('[data-concept="stage"]').click();frame=page.frameLocator('#prototype');await frame.locator('[data-action="library"]').first().click();await frame.locator('[data-action="open-2"]').click();await frame.locator('[data-action="add-detail"]').click();assert.equal(await frame.locator('.stage-next').count(),3);await frame.locator('[data-action="move-2"]').click();await frame.locator('.stage-next').nth(1).locator('strong').filter({hasText:'The Glass Orchard'}).waitFor();await frame.locator('[data-action="queue-play-1"]').click();await frame.locator('h1').filter({hasText:'The Glass Orchard'}).waitFor();await frame.locator('[data-action="timer"]').click();await frame.locator('[data-action="timer-30"]').click();await frame.getByRole('button',{name:'30 min',exact:true}).waitFor();
 console.log('flow journey');await page.locator('[data-concept="journey"]').click();frame=page.frameLocator('#prototype');await frame.locator('[data-action="chapter-13"]').click();await frame.locator('.journey-player h2').filter({hasText:'Out past the harbour'}).waitFor();assert.equal(await frame.locator('[aria-current="step"]').getAttribute('data-action'),'chapter-13');await frame.locator('[data-action="library"]').click();await frame.locator('[data-action="open-3"]').click();await frame.locator('[data-action="detail-play-2"]').click();await frame.locator('.journey-book h1').filter({hasText:'The Night Train North'}).waitFor();await frame.locator('.journey-player h2').filter({hasText:'Carriage number seven'}).waitFor();
 await page.locator('#notes').fill('Keep the shelf and the cover stage. Make the chapter path optional.');await page.locator('#favorite').click();await page.reload();assert.match(await page.locator('#notes').inputValue(),/cover stage/);assert.match(await page.locator('#selection').textContent(),/Chapter journey/);const download=page.waitForEvent('download');await page.locator('#export').click();await(await download).saveAs(join(output,'sample-feedback.md'));
 // Check the review wrapper at narrow width, then the concept at enlarged text.
 await page.setViewportSize({width:320,height:1800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 for(const key of ['dock','split','stage','journey']){await page.locator(`[data-concept="${key}"]`).click();await frame.locator('body button').first().waitFor();await frame.locator('body').evaluate(el=>{el.ownerDocument.documentElement.style.fontSize='200%';});const oversized=await frame.locator('body').evaluate(el=>el.ownerDocument.documentElement.scrollWidth>el.ownerDocument.defaultView.innerWidth);if(oversized)console.log('overflow details',key,await frame.locator('body').evaluate(el=>[...el.querySelectorAll('*')].filter(x=>x.getBoundingClientRect().right>el.ownerDocument.defaultView.innerWidth+1).map(x=>({tag:x.tagName,class:x.className,width:x.getBoundingClientRect().width})).slice(0,12)));assert.equal(oversized,false,key+' enlarged-text overflow');}
 await page.goto(base);await page.keyboard.press('Tab');assert.notEqual(await page.locator(':focus').evaluate(el=>getComputedStyle(el).outlineStyle),'none');
 await page.close();await fs.writeFile(join(output,'verification.json'),JSON.stringify({verified:true,records,concepts:4,screenshots:16,paletteChecks:112,flows:['chapter selection','expanded dock','play state','author-note preference','read along','in-place book switch','search/empty state','seek','queue add/reorder/play','timer','chapter-path selection','book switch with chapter context','per-concept feedback','choice','export','keyboard focus','320px overflow','enlarged concept text'],sampleContentOnly:true},null,2)+'\n');
 console.log(JSON.stringify({verified:true,responsiveAppearanceStates:records.length,screenshots:16,paletteChecks:112,flows:18}));
}finally{await browser.close();server.closeAllConnections();await new Promise(done=>server.close(done));}
