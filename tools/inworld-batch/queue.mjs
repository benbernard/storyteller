import {hash} from './core.mjs';

function settings(queue) {
 const {chapters,estimate,preparationComplete,sourceCommit,sourceRepository,sourceRoot,planner,analysisModule,...fixed}=queue;
 return fixed;
}

/** Only append prepared chapters; a running paid worker never accepts revised inputs. */
export function validateQueueUpdate(previous,next) {
 if(!Array.isArray(next.chapters))throw Error('Queue chapters required');
 const streaming=Array.isArray(next.selectedChapterIds);
 const selected=streaming?next.selectedChapterIds:next.chapters.map(entry=>entry.chapterId);
 if(!selected.length||new Set(selected).size!==selected.length||selected.some(id=>typeof id!=='string'||!id))throw Error('Unique ordered selected chapters required');
 if(streaming&&typeof next.preparationComplete!=='boolean')throw Error('Queue preparation completion required');
 if(next.chapters.length>selected.length)throw Error('Queue exceeds selected chapters');
 const roots=new Set();
 for(const [index,entry]of next.chapters.entries()){
  if(entry.chapterId!==selected[index])throw Error('Queue must preserve selected chapter order');
  if(typeof entry.root!=='string'||!entry.root||roots.has(entry.root)||typeof entry.inputHash!=='string'||!entry.inputHash)throw Error('Unique prepared chapter inputs required');
  roots.add(entry.root);
 }
 if(next.preparationComplete&&next.chapters.length!==selected.length)throw Error('Preparation completed before all selected chapters were queued');
 if(next.estimate?.speechUSD>next.ceilingUSD)throw Error('Prepared speech exceeds budget ceiling');
 if(previous){
  if(hash(settings(previous))!==hash(settings(next)))throw Error('Queue operational settings changed');
  if(next.chapters.length<previous.chapters.length)throw Error('Prepared chapters deleted from queue');
  if(previous.chapters.some((entry,index)=>hash(entry)!==hash(next.chapters[index])))throw Error('Prepared chapter changed after queuing');
  if(previous.preparationComplete&&!next.preparationComplete)throw Error('Queue preparation completion reversed');
 }
 return next;
}

export function queuePreparationComplete(queue) {
 return queue.preparationComplete??!queue.selectedChapterIds;
}

export const archiveExcludes=['*.lock','assembly-temp','runtime','runtime-*','tmp','worker.log'];
