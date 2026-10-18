import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {createRequire} from 'node:module';
const {chromium}=createRequire(resolve('tools/audiobooks/package.json'))('@playwright/test');
const root=resolve('.site-output');
const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json','.png':'image/png','.mp3':'audio/mpeg','.txt':'text/plain'};
const server=createServer(async(req,res)=>{
 try{
  const path=new URL(req.url,'http://localhost').pathname;
  if(!path.startsWith('/storyteller/')){res.writeHead(404);res.end();return;}
  const file=resolve(root,decodeURIComponent(path.slice('/storyteller/'.length)||'index.html'));
  if(!file.startsWith(root+sep))throw new Error('Unsafe path');
  const bytes=await readFile(file);res.setHeader('Content-Type',types[extname(file)]??'application/octet-stream');res.setHeader('Accept-Ranges','bytes');
  const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range??'');
  if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1;if(start>end){res.writeHead(416);res.end();return;}res.writeHead(206,{'Content-Range':'bytes '+start+'-'+end+'/'+bytes.length,'Content-Length':end-start+1});res.end(bytes.subarray(start,end+1));}
  else{res.setHeader('Content-Length',bytes.length);res.end(bytes);}
 }catch{res.writeHead(404);res.end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true});
await mkdir('.agent-scratch/site-checks',{recursive:true});
try{
 for(const width of [320,390,768,1200,1440]){
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']});
  const page=await context.newPage(),errors=[],failed=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)failed.push(r.url());});
  await page.goto(origin+'/storyteller/');
  await page.locator('.passage').first().waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'No horizontal page overflow at '+width);
  assert(await page.locator('.site-header .brand').isVisible());
  await page.screenshot({path:'.agent-scratch/site-checks/landing-'+width+'.png',fullPage:true});
  if(width===1200)await page.screenshot({path:'.agent-scratch/site-checks/landing-fold.png'});
  if(width===390||width===1200){
   for(const provider of ['breeze','qwen','inworld']){
    await page.locator('[data-edition="'+provider+'"]').click();
    await page.locator('.passage').first().waitFor();
    assert.equal(await page.locator('[data-edition="'+provider+'"]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#sample-audio').getAttribute('src'),'samples/'+provider+'.mp3');
    await page.locator('#sample-audio').evaluate(a=>a.play());
    await page.waitForFunction(()=>document.querySelector('#sample-audio').currentTime>0&&!document.querySelector('#sample-audio').paused);
    assert.equal(await page.locator('#sample-audio').evaluate(a=>a.error),null,'Decodes '+provider);
    await page.locator('#sample-audio').evaluate(a=>a.pause());
    const passage=page.locator('.passage').filter({hasText:'All right, Miss Wonderly'}).first();
    await passage.focus();await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('#sample-audio').currentTime>8);
    assert.equal(await passage.getAttribute('aria-current'),'true','Keyboard passage seek for '+provider);
    assert.equal(await page.locator('#sample-audio').evaluate(a=>a.paused),true,'Seeking preserves pause');
   }
   await page.locator('#copy-setup').click();await page.waitForFunction(()=>document.querySelector('#copy-status').textContent==='Setup commands copied.');
   assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/docker compose run --rm sample/);
  }
  assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);
  await context.close();console.log('PASS: Pages subpath, responsive layout, assets'+(width===390||width===1200?', three playable editions, keyboard passage seeking, and copy setup':'')+' at '+width+'px');
 }
 const linked=await browser.newContext();const linkedPage=await linked.newPage();await linkedPage.goto(origin+'/storyteller/?edition=inworld#listen');await linkedPage.locator('.passage').first().waitFor();assert.equal(await linkedPage.locator('#edition-title').textContent(),'Inworld edition');await linked.close();
 const context=await browser.newContext({javaScriptEnabled:false});const page=await context.newPage();await page.goto(origin+'/storyteller/');assert.equal(await page.locator('audio').getAttribute('src'),'samples/breeze.mp3');assert(await page.locator('noscript a').count()===3);await context.close();
 console.log('PASS: audio and transcript downloads remain reachable without JavaScript');
}finally{await browser.close();await new Promise(done=>server.close(done));}
