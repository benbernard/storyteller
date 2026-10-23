import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Store, fingerprint, sha} from './store.js';
import {id} from './schema.js';
import type {Book} from './book.js';

export type SyncProgress = {story:string; edition:string; assembly:string; seconds:number; eventId:string; deviceTime:number; completed:boolean; reason:'playing'|'pause'|'seek'|'passage'|'chapter'|'restore'|'complete'; from?:{story:string;edition:string;assembly:string;seconds:number}; chapterId:string; sequence:number; receivedAt:string; continuationRevision?:number};
export interface Continuation {revision:number; source:string; chapterId:string; updatedAt:string}
export interface SyncState {positions:Record<string,SyncProgress>; continuations?:Record<string,Continuation>; syncSources?:Record<string,number>; syncChanges?:Record<string,Change>}
interface Change {id:string; story:string; revision:number; before:SyncProgress|null; after:SyncProgress; source:string}
export const syncInput = z.object({story:id,chapterId:id,source:z.enum(['bookorbit','royal-road']),sourceRevision:z.number().int().nonnegative(),expectedRevision:z.number().int().nonnegative()}).strict();
type Input=z.infer<typeof syncInput>;
interface Preview {id:string; input:Input; expires:number; expected:string; revision:number; before:SyncProgress|null; target:SyncProgress|null; action:'move'|'preserve'|'duplicate'|'unavailable'; message:string}
export class SyncConflict extends Error {}
export const syncRevision=(saved:SyncState,story:string):number=>saved.continuations?.[story]?.revision??0;
export const latestPosition=(saved:SyncState,story:string):SyncProgress|null=>Object.values(saved.positions).filter(p=>p.story===story).sort((a,b)=>(b.continuationRevision??0)-(a.continuationRevision??0)||b.deviceTime-a.deviceTime)[0]??null;
const snapshot=(saved:SyncState,story:string)=>fingerprint({positions:Object.fromEntries(Object.entries(saved.positions).filter(([,p])=>p.story===story)),continuation:saved.continuations?.[story]??null,sources:Object.fromEntries(Object.entries(saved.syncSources??{}).filter(([key])=>key.startsWith(story+':')))});

/** Caller serializes these operations with ordinary progress writes in the listener. */
export class ContinuationSync<T extends SyncState> {
  constructor(private store:Store,private read:(owner:string)=>Promise<T>,private write:(owner:string,value:T)=>Promise<void>,private book:(story:string)=>Promise<Book>,private record:(owner:string,progress:SyncProgress)=>Promise<void>) {}
  async status(owner:string,story:string) {id.parse(story);const saved=await this.read(owner);return {story,revision:syncRevision(saved,story),position:latestPosition(saved,story),continuation:saved.continuations?.[story]??null,changes:Object.values(saved.syncChanges??{}).filter(c=>c.story===story).slice(-20)};}
  async preview(owner:string,input:Input):Promise<Preview> {
    input=syncInput.parse(input);const saved=await this.read(owner),revision=syncRevision(saved,input.story);
    if(input.expectedRevision!==revision)throw new SyncConflict('The continuation changed. Preview again.');
    const before=latestPosition(saved,input.story),book=await this.book(input.story),edition=before?.edition??book.defaultEdition??Object.keys(book.editions)[0]!;
    const chapter=book.editions[edition]?.chapters.find(c=>c.id===input.chapterId);
    const duplicate=input.sourceRevision<=(saved.syncSources?.[`${input.story}:${input.source}`]??-1);
    const action=duplicate?'duplicate':before?.chapterId===input.chapterId?'preserve':chapter?'move':'unavailable';
    const preview:Preview={id:randomUUID(),input,expires:Date.now()+600000,expected:snapshot(saved,input.story),revision,before,target:chapter?{story:input.story,edition,assembly:chapter.assembly,seconds:0,eventId:randomUUID(),deviceTime:Date.now(),completed:false,reason:'chapter',chapterId:chapter.id,sequence:chapter.sequence,receivedAt:new Date().toISOString()}:null,action,message:action==='unavailable'?'Audio is unavailable for this chapter in your selected edition.':action==='preserve'?'Keeping your precise audio position in this chapter.':action==='duplicate'?'This source revision was already handled.':'Continue at the start of the selected chapter.'};
    await this.store.write(`sync-previews/${sha(owner)}/${preview.id}.json`,preview);return preview;
  }
  async apply(owner:string,previewId:string) {
    z.uuid().parse(previewId);const saved=await this.read(owner),done=saved.syncChanges?.[previewId];if(done)return {saved:true,change:done};
    const path=`sync-previews/${sha(owner)}/${previewId}.json`,p=await this.store.read<Preview>(path);if(!p)throw new Error('not_found');
    if(p.expires<Date.now()||snapshot(saved,p.input.story)!==p.expected)throw new SyncConflict('Your position changed or this preview expired. Preview again.');
    if(p.action==='unavailable')return {saved:false,story:p.input.story,action:p.action,message:p.message};
    if(p.action==='duplicate')return {saved:true,story:p.input.story,action:p.action};
    saved.syncSources??={};saved.syncSources[`${p.input.story}:${p.input.source}`]=p.input.sourceRevision;
    if(p.action==='preserve'){await this.write(owner,saved);return {saved:true,story:p.input.story,action:p.action};}
    return this.move(owner,saved,p,p.target!);
  }
  private async move(owner:string,saved:T,p:Preview,target:SyncProgress) {
    const revision=syncRevision(saved,p.input.story)+1;
    // Persisted event identity/time makes retries safe after a lost response or crash.
    const after={...target,eventId:p.id,continuationRevision:revision,...(p.before?{from:{story:p.before.story,edition:p.before.edition,assembly:p.before.assembly,seconds:p.before.seconds}}:{})};
    await this.record(owner,after);
    saved.positions[`${after.story}:${after.edition}:${after.chapterId}`]=after;
    saved.continuations??={};saved.continuations[after.story]={revision,source:p.input.source,chapterId:after.chapterId,updatedAt:after.receivedAt};
    const change:Change={id:p.id,story:after.story,revision,before:p.before?{...p.before}:null,after:{...after},source:p.input.source};
    saved.syncChanges??={};saved.syncChanges[p.id]=change;
    await this.write(owner,saved);return {saved:true,action:'move',change};
  }
  async undo(owner:string,changeId:string) {
    z.uuid().parse(changeId);const saved=await this.read(owner),change=saved.syncChanges?.[changeId];
    if(!change?.before)throw new SyncConflict('There is no earlier listening position to restore.');
    if(latestPosition(saved,change.story)?.eventId!==change.after.eventId)throw new SyncConflict('You have moved since this change. Your current position was kept.');
    const p:Preview={id:randomUUID(),input:{story:change.story,chapterId:change.before.chapterId,source:'bookorbit',sourceRevision:0,expectedRevision:syncRevision(saved,change.story)},expires:Date.now()+600000,expected:snapshot(saved,change.story),revision:syncRevision(saved,change.story),before:change.after,target:null,action:'move',message:'Restore the previous audio bookmark.'};
    return this.move(owner,saved,p,{...change.before,deviceTime:Date.now(),receivedAt:new Date().toISOString(),completed:false,reason:'restore'});
  }
}
