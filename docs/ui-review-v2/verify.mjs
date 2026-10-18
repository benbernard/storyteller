import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
const require=createRequire(new URL('../../tools/audiobooks/package.json',import.meta.url));
const {chromium}=require('@playwright/test');
const output=resolve(process.argv[2]??'.agent-scratch/ui-review-v2');
const html=await fs.readFile(join(output,'storyteller-design-review-v2.html'));
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});
const checks=[];
try{
 for(const concept of ['canvas','deck','shelf','studio'])for(const width of [375,1280]){
  const page=await browser.newPage({viewport:{width,height:1100},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.setDefaultTimeout(15000);console.log('render',concept,width);await page.goto(`${base}/#${concept}${width===1280?'?desktop':''}`);
  const f=page.frameLocator('#prototype');await f.locator('body button').first().waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await f.locator('body').evaluate(el=>el.ownerDocument.documentElement.scrollWidth>el.ownerDocument.defaultView.innerWidth),false,concept+' frame overflow');
  await page.locator('#prototype').screenshot({path:join(output,`${concept}-home-${width}.png`)});
  const selector={canvas:'[data-action="passage"]',deck:'[data-action="read"]',shelf:'[data-action="book-0"]',studio:'[data-action="inspect-12"]'}[concept];
  await f.locator(selector).click();
  await f.getByText({canvas:'This passage',deck:'Read along',shelf:'Your place',studio:'One passage needs attention.'}[concept],{exact:true}).first().waitFor();
  await page.locator('#prototype').screenshot({path:join(output,`${concept}-detail-${width}.png`)});
  assert.deepEqual(errors,[]);checks.push({concept,width,homeAndDetail:true,noOverflow:true});await page.close();
 }
 const page=await browser.newPage({viewport:{width:960,height:1800},reducedMotion:'reduce'});
 page.setDefaultTimeout(15000);console.log('flows canvas');await page.goto(`${base}/#canvas`);let f=page.frameLocator('#prototype');await f.locator('[data-action="chapters"]').click();await f.locator('[data-action="chapter-13"]').click();await f.getByText('CHAPTER 13 / 28 · 24 MINUTES').waitFor();await f.locator('[data-action="type"]').click();await f.locator('[data-field="notes"]').uncheck();await f.locator('[data-action="close"]').first().click();await page.locator('#prototype').scrollIntoViewIfNeeded();await f.locator('[data-action="play"]').click();await f.getByRole('button',{name:'Pause',exact:true}).waitFor();assert.equal(await f.getByText('Author’s note ·',{exact:false}).count(),0);
 console.log('flows deck');await page.locator('[data-concept="deck"]').click();f=page.frameLocator('#prototype');await f.locator('[data-action="deck-add"]').first().click();await f.locator('[data-action="queue-23"]').click();await f.getByText('4 chapters',{exact:true}).waitFor();await f.locator('[data-action="remove-23"]').click();await f.getByText('3 chapters',{exact:true}).waitFor();await f.locator('[data-action="timer"]').click();await f.locator('[data-action="timer-20"]').click();await f.getByRole('button',{name:'20 min timer'}).waitFor();
 console.log('flows shelf');await page.locator('[data-concept="shelf"]').click();f=page.frameLocator('#prototype');await f.locator('#shelf-search').fill('no such book');await f.getByText('No matching books. Try another title or author.').waitFor();await f.locator('#shelf-search').fill('Lighthouse');assert.equal(await f.locator('.book-object').count(),1);await f.locator('[data-action="book-0"]').click();await f.locator('[data-action="tab-audio"]').click();await f.locator('[data-field="notes"]').uncheck();assert.equal(await f.locator('[data-field="notes"]').isChecked(),false);
 console.log('flows studio');await page.locator('[data-concept="studio"]').click();f=page.frameLocator('#prototype');await f.locator('[data-action="stage-review"]').click();assert.equal(await f.locator('.production-column').count(),1);await f.locator('[data-action="inspect-12"]').click();await f.locator('[data-action="review-repair"]').click();await f.getByText('Targeted repair preview',{exact:true}).waitFor();await f.locator('[data-action="close"]').first().click();await f.locator('[data-action="review-later"]').click();await f.getByText('Kept in Needs review. No quality check was bypassed.').waitFor();
 await page.locator('#notes').fill('The studio is useful for making audio, but I want the deck for listening.');await page.locator('#favorite').click();await page.reload();assert.match(await page.locator('#notes').inputValue(),/studio/);assert.match(await page.locator('#selection').textContent(),/Studio desk/);
 const download=page.waitForEvent('download');await page.locator('#export').click();await (await download).saveAs(join(output,'sample-feedback.md'));
 await page.setViewportSize({width:320,height:1000});await page.addStyleTag({content:'html{font-size:200%}'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.goto(base);await page.keyboard.press('Tab');assert.notEqual(await page.locator(':focus').evaluate(el=>getComputedStyle(el).outlineStyle),'none');
 await page.close();await fs.writeFile(join(output,'verification.json'),JSON.stringify({verified:true,checks,interactiveFlows:['chapter drawer','context passage','play state','author-note preference','session queue add/remove','timer','read along','collection search/empty state','book chapters/audio','production stage filter','chapter inspector','repair scope preview','review later','per-concept local feedback','favorite','export','keyboard focus','320px enlarged text'],sampleContentOnly:true,screenshots:16},null,2)+'\n');
 console.log(JSON.stringify({verified:true,concepts:4,responsiveStates:8,screenshots:16,interactiveFlows:18}));
}finally{await browser.close();await new Promise(done=>server.close(done));}
