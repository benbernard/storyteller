import {spawnSync} from 'node:child_process';
import {mkdir,writeFile,readFile,chmod} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
if(process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Local speech requires Apple Silicon macOS');
process.umask(0o077);
const home=resolve(process.env.MAC_TTS_HOME ?? 'data/mac-tts');
for(const folder of ['', 'audio', 'references', 'voices', 'prompts', 'cache'])await mkdir(resolve(home,folder),{recursive:true,mode:0o700});
const run=(cmd,args)=>{const p=spawnSync(cmd,args,{stdio:'inherit'});if(p.status!==0)throw new Error(cmd+' failed; install prerequisites in docs/local-generation.md');};
for(const [folder,lock] of [['venv','mlx'],['qwen-venv','qwen']]){
 run('uv',['venv','--allow-existing','--python','3.12',resolve(home,folder)]);
 run('uv',['pip','sync','--python',resolve(home,folder,'bin/python'),'tools/mac-tts/requirements-'+lock+'.lock']);
}
const auth=resolve(home,'auth.json');
try{await writeFile(auth,JSON.stringify(['admin','nas'].map(scope=>({scope,token:randomBytes(48).toString('base64url')}))),{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
const grants=JSON.parse(await readFile(auth,'utf8'));
await mkdir('data/credentials',{recursive:true,mode:0o700});
await writeFile('data/credentials/mac-client.json',JSON.stringify({endpoint:'http://127.0.0.1:8788',token:grants.find(g=>g.scope==='nas').token}),{mode:0o600});
console.log('Mac environments and private credentials ready. Model weights download on first load. Start with node scripts/start-mac.mjs.');
