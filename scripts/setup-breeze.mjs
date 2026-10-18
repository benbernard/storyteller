import {spawnSync} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
if(existsSync('.env'))process.loadEnvFile('.env');
if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('Breeze requires Apple Silicon macOS');
process.umask(0o077);
const home=resolve(process.env.MAC_TTS_HOME??'data/mac-tts');
for(const dir of ['', 'audio','references','voices','prompts','cache'])await mkdir(resolve(home,dir),{recursive:true,mode:0o700});
const run=(command,args)=>{const result=spawnSync(command,args,{stdio:'inherit',env:{...process.env,HF_HOME:resolve(home,'cache/huggingface')}});if(result.error)throw result.error;if(result.status!==0)throw new Error(command+' failed; see docs/breeze.md');};
for(const [folder,lock]of [['venv','mlx'],['asr-venv','asr'],['phoneme-venv','mlx']]){
 run('uv',['venv','--allow-existing','--python','3.12',resolve(home,folder)]);
 run('uv',['pip','sync','--python',resolve(home,folder,'bin/python'),'tools/mac-tts/requirements-'+lock+'.lock']);
}
const auth=resolve(home,'auth.json');
try{await writeFile(auth,JSON.stringify(['admin','nas'].map(scope=>({scope,token:randomBytes(48).toString('base64url')}))),{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
const grants=JSON.parse(await readFile(auth,'utf8'));
await mkdir('data/credentials',{recursive:true,mode:0o700});
await writeFile('data/credentials/mac-client.json',JSON.stringify({endpoint:'http://127.0.0.1:8788',token:grants.find(g=>g.scope==='nas').token}),{mode:0o600});
if(!process.argv.includes('--skip-download'))run(resolve(home,'venv/bin/python'),['tools/mac-tts/acting-auditions/download_models.py']);
console.log('Breeze, review environments, and private credentials ready. Start node scripts/start-mac.mjs in another terminal.');
