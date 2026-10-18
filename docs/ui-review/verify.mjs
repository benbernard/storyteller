import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
const require=createRequire(new URL('../../tools/audiobooks/package.json',import.meta.url));
const {chromium}=require('@playwright/test');
const output=resolve(process.argv[2]??'.agent-scratch/ui-review');
const html=await fs.readFile(join(output,'storyteller-design-review.html'));
const luminance=value=>{const rgb=[1,3,5].map(i=>parseInt(value.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];};
const contrast=(a,b)=>{const [low,high]=[luminance(a),luminance(b)].sort((a,b)=>a-b);return (high+.05)/(low+.05);};
let contrastPairs=0;
for(const match of html.toString().matchAll(/([^{}]+)\{([^{}]+)\}/g)){
 const palette=Object.fromEntries([...match[2].matchAll(/--(bg|surface|ink|muted|accent|on-accent|soft|line):(#[0-9a-fA-F]{6})/g)].map(m=>[m[1],m[2]]));if(Object.keys(palette).length!==8)continue;
 const pairs=['ink','muted'].flatMap(a=>['bg','surface','soft'].map(b=>[a,b,4.5]));pairs.push(['on-accent','accent',4.5],['line','surface',3]);
 for(const [a,b,minimum]of pairs){assert.ok(contrast(palette[a],palette[b])>=minimum,`Insufficient ${a}/${b} contrast`);contrastPairs++;}
}
assert.equal(contrastPairs,48);
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});const results=[];
try{
 for(const concept of ['bookshelf','focus','spaces'])for(const width of [375,1280])for(const mode of ['light','dark']){
  const page=await browser.newPage({viewport:{width,height:1100},reducedMotion:'reduce'}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  for(const screen of ['library','player','activity']){
   await page.goto(`${base}/#concept=${concept}&screen=${screen}&width=${width===375?'phone':'wide'}&mode=${mode}`);
   await page.waitForFunction(value=>document.querySelector('#app')?.dataset.screen===value,screen);await page.locator('#app h2').waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${concept}/${screen}/${width}/${mode} overflow`);
   if(mode===(concept==='focus'?'dark':'light'))await page.locator('#app').screenshot({path:join(output,`${concept}-${screen}-${width}.png`)});
   results.push({concept,screen,width,mode,overflow:false});
  }
  assert.deepEqual(errors,[]);await page.close();
 }
 const page=await browser.newPage({viewport:{width:375,height:1000},reducedMotion:'reduce'});await page.goto(base);
 await page.locator('#book-query').fill('not in the library');await page.getByText('No matching books. Try another title or author.').waitFor();
 await page.locator('#book-query').fill('"<test>');await page.locator('#favorite').click();assert.equal(await page.locator('#book-query').inputValue(),'"<test>');
 await page.locator('#book-query').fill('');await page.getByRole('button',{name:'Continue chapter 12',exact:true}).click();
 assert.equal(await page.locator('#app [data-action="play"]').textContent(),'Pause');await page.locator('#app [data-action="play"]').click();assert.equal(await page.locator('#app [data-action="play"]').textContent(),'Play');
 const original=await page.locator('#position').inputValue();await page.locator('#app [data-action="back"]').click();assert.equal(Number(await page.locator('#position').inputValue()),Number(original)-15);
 await page.locator('#app [data-action="settings"]').first().click();await page.locator('#include-notes').uncheck();assert.equal(await page.locator('#include-notes').isChecked(),false);
 await page.locator('#comments').fill('Keep the resume button. Move preparation away from listening.');await page.locator('#favorite').click();await page.reload();assert.equal(await page.locator('#comments').inputValue(),'Keep the resume button. Move preparation away from listening.');assert.match(await page.locator('#favorite-status').textContent(),/Bookshelf/);
 const download=page.waitForEvent('download');await page.locator('#download-notes').click();await (await download).saveAs(join(output,'sample-review-notes.md'));
 // Keyboard access is native; verify the first review action receives a visible focus outline.
 await page.goto(base);await page.keyboard.press('Tab');assert.notEqual(await page.locator(':focus').evaluate(element=>getComputedStyle(element).outlineStyle),'none');
 await page.setViewportSize({width:320,height:900});await page.addStyleTag({content:'html{font-size:200%}'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.close();await fs.writeFile(join(output,'verification.json'),JSON.stringify({verified:true,renderedStates:results.length,results,interactions:['search','safe input retention','transport','seek','author-note toggle','saved feedback','choice','export','keyboard focus','320px large text'],privateBookContent:false},null,2)+'\n');
 console.log(JSON.stringify({verified:true,renderedStates:results.length,screenshots:18,interactions:10,contrastPairs}));
}finally{await browser.close();await new Promise(done=>server.close(done));}
