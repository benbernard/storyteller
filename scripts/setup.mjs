import {mkdir,readFile,writeFile,chmod,copyFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
for(const dir of ['fictions','listener','archive','automation/jobs','input','exports','credentials','codex']) await mkdir('data/'+dir,{recursive:true,mode:0o700});
try{await copyFile('.env.example','.env',1);}catch(e){if(e.code!=='EEXIST')throw e;}
try{await writeFile('data/credentials/listener-password',randomBytes(32).toString('base64url')+'\n',{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
for(const file of ['fiction.json','chapter.json','analysis.json'])try{await copyFile('tools/audiobooks/examples/'+file,'data/input/'+file,1);}catch(e){if(e.code!=='EEXIST')throw e;}
console.log('Private state ready in data/. Login user: listener. Password file: data/credentials/listener-password. Existing files were preserved.');

let env = await readFile('.env','utf8');
for(const [key,value] of Object.entries({LOCAL_UID:process.getuid?.() ?? 1000, LOCAL_GID:process.getgid?.() ?? 1000})) if(!new RegExp('^'+key+'=', 'm').test(env)) env += '\n'+key+'='+value+'\n';
await writeFile('.env',env,{mode:0o600});await chmod('.env',0o600);
