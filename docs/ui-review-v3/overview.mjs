import fs from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../tools/audiobooks/package.json',import.meta.url));
const {chromium}=require('@playwright/test');
const output=resolve(process.argv[2]??'.agent-scratch/ui-review-v3');
const names=[['dock','1 · Shelf & dock','Library first; expand to listen'],['split','2 · Side by side','Collection and player together'],['stage','3 · Cover stage','Listening first; browse in place'],['journey','4 · Chapter journey','Follow the book chapter by chapter']];
const panels=await Promise.all(names.map(async([key,title,subtitle])=>`<section><h2>${title}</h2><p>${subtitle}</p><img src="data:image/png;base64,${(await fs.readFile(join(output,key+'-home-375.png'))).toString('base64')}" alt="${title} phone prototype"></section>`));
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Storyteller Shelf × Deck</title><style>*{box-sizing:border-box}body{margin:0;background:#e8edef;color:#202a31;font:16px system-ui;padding:35px}h1{font-size:32px;letter-spacing:-.04em;margin:0 0 8px}.intro{color:#52606b;margin:0 0 30px}.panels{display:grid;grid-template-columns:repeat(4,1fr);gap:24px}h2{font-size:21px;margin:0 0 6px;letter-spacing:-.03em}section p{font-size:13px;margin:0 0 16px;color:#52606b}img{width:100%;border-radius:8px;display:block;box-shadow:0 3px 16px #15252f18}footer{font-size:12px;color:#52606b;margin-top:26px}</style></head><body><h1>Shelf × Deck: four ways to bring them together.</h1><p class="intro">Storyteller · Round three · Built on the Listening deck and Visual shelf</p><div class="panels">${panels.join('')}</div><footer>Interactive concepts use invented sample stories. No new app layout is approved. Open the review to try each workflow on phone and desktop.</footer></body></html>`;
await fs.writeFile(join(output,'overview.html'),html);
const browser=await chromium.launch({headless:true});try{const page=await browser.newPage({viewport:{width:1440,height:1120},deviceScaleFactor:1});await page.setContent(html);await page.locator('img').last().waitFor();await page.screenshot({path:join(output,'shelf-deck-overview.png'),fullPage:true});}finally{await browser.close();}
console.log(JSON.stringify({overview:join(output,'shelf-deck-overview.png')}));
