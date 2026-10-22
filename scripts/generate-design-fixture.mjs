import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const path=new URL('../tools/audiobooks/test-fixtures/listener-design.json',import.meta.url),fixture=JSON.parse(await readFile(path));
const hash=value=>createHash('sha256').update(value).digest('hex');
const sampleBytes=index=>{const bytes=Buffer.alloc(8*1024*1024);bytes[0]=index;return bytes;};
const editions=['v3','flash','qwen'],positions={},completed={},readings={};
const books=fixture.books.filter(b=>b.ready).map(b=>{
 const done=b.id==='lighthouse'?Array.from({length:11},(_,i)=>i+1):b.id==='tides'?[1,2,3,5,6]:[];
 for(const sequence of done)completed[`${b.id}:chapter-${sequence}`]=true;
 const active=b.initialChapter,seconds=b.id==='lighthouse'?496:b.id==='tides'?158:0;
 const currentDuration=b.id==='lighthouse'?1460:b.id==='tides'?780:1250;
 const remaining=b.id==='lighthouse'?15120:b.id==='tides'?9960:30000;
 const otherDuration=b.unplayed>1?(remaining-(currentDuration-seconds))/(b.unplayed-1):currentDuration;
 const result={id:b.id,title:b.title,author:b.author,defaultEdition:'v3',editions:Object.fromEntries(editions.map(edition=>[edition,{chapters:Array.from({length:b.id==='orchard'&&edition==='qwen'?6:b.totalChapters},(_,i)=>{
  const sequence=i+1,source=(b.chapters||fixture.chapters)[sequence],assembly=hash(`${b.id}-${edition}-${sequence}`);
  const duration=sequence===active?currentDuration:otherDuration;
  const chapter={id:`chapter-${sequence}`,sequence,title:source?.title||`Chapter ${sequence}`,assembly,duration,...(b.id==='lighthouse'&&edition==='v3'?{checksum:hash(sampleBytes(sequence))}:{})};
  if(source){const starts=b.editions?.[edition]?.starts||[0,180,496,920,1040,1140,1260,1380],end=b.editions?.[edition]?.duration||1460;readings[assembly]={assembly,chapterId:chapter.id,sequence,title:chapter.title,duration,passages:source.paragraphs.map((text,index)=>({id:`paragraph-${index}`,start:starts[index]*duration/end,end:(starts[index+1]||end)*duration/end,text:text+'\n\n'}))};}
  return chapter;
 })}]))};
 if(b.started){const chapter=result.editions.v3.chapters[active-1];positions[`${b.id}:v3:${chapter.id}`]={story:b.id,edition:'v3',assembly:chapter.assembly,seconds,deviceTime:b.id==='lighthouse'?1792630800000:1792630000000};}
 return result;
});
const issues=[{id:'review-pronunciation',story:'lighthouse',chapterId:'chapter-12',sequence:12,edition:'v3',seconds:496,kind:'pronunciation',status:'open',note:'The keeper’s name sounds different from the previous chapter.'},{id:'review-pacing',story:'lighthouse',chapterId:'chapter-11',sequence:11,edition:'v3',seconds:190,kind:'delivery',status:'open',note:'There is a long pause in the middle of this sentence.'},{id:'review-repeat',story:'tides',chapterId:'chapter-4',sequence:4,edition:'flash',seconds:158,kind:'missing',status:'resolved',note:'This line repeats twice.'}];
fixture.api={library:{accountKey:hash('fictional-design-review'),books,state:{positions,completed,seen:{},issues}},catalog:{stories:fixture.books.map(b=>({id:b.id,title:b.title,author:b.author,description:b.description,url:'https://example.test/story',hasCover:true,supported:true,checkedAt:'2026-10-21T22:20:00Z',follow:{enabled:true,mode:'buffer',intervalHours:6},chapters:Array.from({length:b.totalChapters||20},(_,i)=>({title:`Chapter ${i+1}`,editions:b.id==='midnight'?[]:b.id==='orchard'&&i>=6?[]:['qwen']})),...(b.id==='orchard'?{repair:{title:'Audio updating',detail:'Published audio remains available.',completed:6,total:24,chapters:[{id:'chapter-7',title:'Chapter 7',label:'Generating audio'},{id:'chapter-8',title:'Chapter 8',label:'Queued'}]}}:{})})),jobs:[{id:'fictional-preparation',story:'orchard',status:'running',phase:'Working on chapter 7.'},{id:'fictional-unpublished',story:'midnight',status:'running',phase:'6 of 20 chapters prepared'}]},readings};
issues.forEach((issue,index)=>{issue.createdAt=new Date(1792630800000-index*2400000).toISOString();});
const light=books[0];
fixture.api.history=[{sequence:12,seconds:496,edition:'v3',reason:'chapter',minutes:12},{sequence:11,seconds:184,edition:'v3',reason:'passage',minutes:38},{sequence:12,seconds:215,edition:'flash',reason:'seek',minutes:1440}].map((item,index)=>{
 const chapter=light.editions[item.edition].chapters[item.sequence-1],reading=readings[chapter.assembly],passage=reading.passages.findLast(p=>p.start<=item.seconds);
 return {eventId:`fictional-jump-${index}`,reason:item.reason,deviceTime:1792630800000-item.minutes*60000,from:{story:light.id,bookTitle:light.title,edition:item.edition,assembly:chapter.assembly,chapter:item.sequence,chapterTitle:chapter.title,seconds:item.seconds,excerpt:passage.text.slice(0,200),selection:{story:light.id,bookTitle:light.title,edition:item.edition,chapter}}};
});
await writeFile(path,JSON.stringify(fixture,null,2)+'\n');
console.log('Generated fictional API fixtures from the approved design content.');
