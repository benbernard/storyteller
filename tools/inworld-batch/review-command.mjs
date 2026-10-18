import fs from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';

/** Installed Mac jobs lease the GPU for ASR only; other adapters remain unchanged. */
export async function asrReviewCommand(config,here,root,{platform=process.platform,home=homedir(),env=process.env}={}){
 const args=[config.python,join(here,'review.py'),root];
 const cpu={command:'/usr/bin/nice',args:['-n','15',...args]};
 if(platform!=='darwin'||env.INWORLD_REVIEW_GPU_LEASE==='1'||!config.sourceRoot||!/^[a-f0-9]{40}$/.test(config.sourceCommit??'')||resolve(here)!==resolve(config.sourceRoot,'tools/inworld-batch'))return cpu;
 const credential=join(home,'.local/share/mac-tts/auth.json');
 try{
  if((await fs.readFile(join(config.sourceRoot,'source-commit.txt'),'utf8')).trim()!==config.sourceCommit)return cpu;
  await fs.access(credential);
 }catch(error){if(error.code==='ENOENT')return cpu;throw error;}
 return {command:'/usr/bin/nice',args:['-n','15',process.execPath,join(here,'review-gpu.mjs'),credential,'--auto','--',...args]};
}
