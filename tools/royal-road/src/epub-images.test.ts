import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import sharp from 'sharp';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'cheerio';
import { unzipSync, strFromU8 } from 'fflate';
import { epubImage } from './epub-images.js';
import { sync } from './download.js';
import { exportEpub } from './epub.js';

const pixels=()=>sharp({create:{width:3,height:2,channels:4,background:{r:20,g:100,b:200,alpha:0.5}}});
test('WebP and AVIF become lossless PNGs with dimensions and transparency preserved',async()=>{
 for(const bytes of [await pixels().webp({lossless:true}).toBuffer(),await pixels().avif({lossless:true}).toBuffer()]) {
  const result=await epubImage(bytes);assert.equal(result.mime,'image/png');assert.equal(result.extension,'png');
  const metadata=await sharp(result.bytes).metadata();assert.equal(metadata.width,3);assert.equal(metadata.height,2);assert.equal(metadata.hasAlpha,true);
 }
 await assert.rejects(epubImage(Buffer.from('not an image')),/invalid image/i);
});

test('EPUB embeds its cover and every chapter/author-note image using local image paths',async()=>{
 const root=await mkdtemp(join(tmpdir(),'epub-images-'));
 const cover=await pixels().webp({lossless:true}).toBuffer();
 const inline=await pixels().avif({lossless:true}).toBuffer();
 const note=await pixels().png().toBuffer();
 try {
  const toc='<h1>Illustrated story</h1><meta property="og:image" content="https://example.com/cover.webp"><table id="chapters"><tbody><tr><td><a href="/fiction/42/story/chapter/1/one">One</a></td></tr></tbody></table>';
  const chapter='<h1>One</h1><div class="author-note-portlet"><img src="https://example.com/note.png" alt="Author note"></div><div class="chapter-content"><p>Illustrated chapter</p><img src="https://example.com/art.avif" alt="Chapter art"></div>';
  const result=await sync(root,'42',async url=>url.includes('/chapter/')?chapter:toc,{getImage:async url=>({bytes:url.endsWith('.webp')?cover:url.endsWith('.avif')?inline:note,mime:'application/octet-stream'})});
  assert.equal(result.mediaErrors,0);
  const edition=await exportEpub(root,'rr-42');assert.equal(edition.mediaErrors,0);
  const zip=unzipSync(await readFile(join(root,'rr-42/editions',edition.id+'.epub')));
  const opf=load(strFromU8(zip['OEBPS/content.opf']!),{xml:true});
  const coverItem=opf('item[properties="cover-image"]');assert.equal(coverItem.length,1);assert.equal(coverItem.attr('media-type'),'image/png');
  assert.ok(zip['OEBPS/'+coverItem.attr('href')]);
  const hrefs=opf('manifest item').toArray().map(el=>opf(el).attr('href'));assert.equal(new Set(hrefs).size,hrefs.length,'Each packaged image has one manifest entry');
  const xhtml=load(strFromU8(zip['OEBPS/rr-1.xhtml']!),{xml:true});assert.equal(xhtml('img').length,2);
  for(const el of xhtml('img').toArray()) {
   const src=xhtml(el).attr('src')!;assert.match(src,/^images\/[a-f0-9]{64}\.png$/);assert.ok(zip['OEBPS/'+src]);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('animated WebP keeps both frames when converted to GIF',async()=>{
 const red=[255,0,0,255],blue=[0,0,255,255];
 const frames=Buffer.from([...Array(4).fill(red).flat(),...Array(4).fill(blue).flat()]);
 const webp=await sharp(frames,{raw:{width:2,height:4,channels:4,pageHeight:2}}).webp({lossless:true,loop:0,delay:[50,80]}).toBuffer();
 const result=await epubImage(webp);assert.equal(result.mime,'image/gif');
 const metadata=await sharp(result.bytes,{animated:true}).metadata();assert.equal(metadata.pages,2);assert.equal(metadata.pageHeight,2);
});
