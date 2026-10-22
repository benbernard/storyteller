import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,value,index,list)=>index%2?pairs:[...pairs,[value.replace(/^--/,''),list[index+1]]],[]));
if(!args.source||!args.output)throw Error('Usage: node scripts/capture-design-reference.mjs --source PUBLIC_WORKTREE --output SCRATCH --base http://127.0.0.1:8771');
const base=args.base||'http://127.0.0.1:8771';if(!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('Serve the pinned review files on loopback.');
const require=createRequire(join(resolve(args.source),'tools/audiobooks/package.json')),{chromium}=require('@playwright/test');
const browser=await chromium.launch({headless:true}), evidence=[];
const files=['storyteller-design-review-v3.html','storyteller-listening-r17.html'];
const sourceHashes=Object.fromEntries(await Promise.all(files.map(async name=>{const response=await fetch(base+'/'+name);if(!response.ok)throw Error('Reference unavailable: '+name);return[name,createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex')];})));
if(sourceHashes[files[0]]!=='08017fabcd62f89ee1fc315550840f408e2d2f6878c45974bb00c2387cca8f9a')throw Error('The library/account reference differs from the approved artifact.');
if(sourceHashes[files[1]]!=='d42ed0352874c60cddabffbd5f89d3fd6fcf9016eba3f34267376031c7a27416')throw Error('The reader reference differs from the approved artifact.');
try {
 for(const profile of [{name:'phone',width:1280,height:900},{name:'narrow-large',width:1280,height:1000,large:true},{name:'expanded-dark',width:872,height:1000,wide:true,dark:true}]) {
  const context=await browser.newContext({viewport:{width:profile.width,height:profile.height},reducedMotion:'reduce'}),dir=resolve(args.output,profile.name);await mkdir(dir,{recursive:true});
  const open=async(view,book='lighthouse',reader=false)=>{
   const page=await context.newPage();await page.goto(base+'/'+(reader?files[1]+'?book='+book:files[0]+'?review=account-r2&'+(view==='library'?'library=1':'view='+view+'&book='+book)));
   await page.locator(reader?'#app svg':'#account-entry svg').first().waitFor({state:'attached'});
   if(profile.large||profile.wide||profile.dark){await page.locator('.review-tools > summary').click();if(profile.large){await page.locator('#small-preview').click();await page.locator('#large').check();}if(profile.wide)await page.locator('#size').click();if(profile.dark)await page.locator('#appearance').click();await page.locator('.review-tools > summary').click();}
   return page;
  };
  const capture=async(page,name)=>{
   if(!await page.locator('dialog[open]').count())await page.locator('.review-head strong').click();
   const file=name+'.png';await page.locator('#preview').screenshot({path:join(dir,file)});
   if(await page.locator('dialog[open]').count())await page.locator('dialog[open]').screenshot({path:join(dir,name+'-sheet.png')});
   evidence.push({profile:profile.name,screen:name,file:profile.name+'/'+file,route:new URL(page.url()).search,sha256:createHash('sha256').update(await readFile(join(dir,file))).digest('hex')});
  };
  for(const [view,name] of [['library','01-library'],['book','02-book'],['chapters','03-chapters'],['downloads','09-downloads'],['issues','11-marked-issues'],['preparation','12-preparation'],['account','14-account'],['connect','16-sign-in']]) {
   const page=await open(view,view==='preparation'?'orchard':'lighthouse');await capture(page,name);
   if(view==='library'){await page.getByRole('button',{name:'More options for The Lighthouse Letters',exact:true}).click();await capture(page,'state-book-menu');await page.locator('#book-menu-clear').click();await capture(page,'state-clear-downloads-confirmation');}
   if(view==='downloads'){await page.locator('#sync').click();await capture(page,'10-download-settings');}
   if(view==='preparation'){await page.locator('#sync').click();await capture(page,'13-preparation-settings');}
   if(view==='account'){await page.getByRole('button',{name:'Sign out',exact:true}).click();await capture(page,'15-sign-out');}
   if(view==='connect'){await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.locator('#browser-signin').waitFor();await page.locator('#close-browser-signin').click();await capture(page,'17-sign-in-browser');}
   await page.close();
  }
  for(const scenario of ['empty','loading','error','offline']){const page=await open('library');await page.locator('.review-tools > summary').click();await page.locator('#scenario').selectOption(scenario);await page.locator('.review-tools > summary').click();await capture(page,'state-library-'+(scenario==='error'?'refresh-failure':scenario));await page.close();}
  for(const scenario of ['failed','wifi','offline','storage','complete']){const page=await open('downloads');await page.locator('.review-tools > summary').click();await page.locator('#download-scenario').selectOption(scenario);await page.locator('.review-tools > summary').click();await capture(page,'state-downloads-'+(scenario==='failed'?'failure':scenario==='offline'?'connection':scenario));await page.close();}
  for(const scenario of ['queued','running','failed','waiting','cancelled','complete','offline','readonly','unsupported']){const page=await open('preparation','orchard');await page.locator('.review-tools > summary').click();await page.locator('#prep-example').selectOption(scenario);await page.locator('.review-tools > summary').click();await capture(page,'state-preparation-'+(scenario==='readonly'?'view-only':scenario));await page.close();}
  const page=await open('reading','lighthouse',true);await capture(page,'04-listening');
  const playingPage=await open('reading','lighthouse',true);
  await playingPage.getByRole('button',{name:'Play',exact:true}).click();await capture(playingPage,'state-listening-playing');
  await playingPage.getByRole('button',{name:'Back 15 seconds',exact:true}).click();await capture(playingPage,'state-listening-playing-with-undo');await playingPage.close();
  for(const [button,name] of [['Settings','05-listening-settings'],['Playback speed: 1.0×','06-speed'],['Recent jumps','07-jumps']]){await page.getByRole('button',{name:button,exact:true}).click();await capture(page,name);await page.getByRole('button',{name:'Close',exact:true}).click();}
  await page.getByRole('button',{name:'Mark issue at 8:16',exact:true}).click();await capture(page,'08-mark-issue');await page.close();
  await context.close();console.log('Captured approved references at '+profile.name);
 }
 await writeFile(join(resolve(args.output),'evidence.json'),JSON.stringify({sourceHashes,captures:evidence},null,2)+'\n');
} finally {await browser.close();}
