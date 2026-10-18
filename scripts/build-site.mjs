// A fixed public allowlist keeps the Pages artifact independent of local state and credentials.
import {mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const output = resolve('.site-output');
const files = new Map([
  ['site/index.html','index.html'],['site/style.css','style.css'],['site/app.js','app.js'],
  ['tools/audiobooks/listener-web/storyteller-mark.png','assets/storyteller-mark.png'],
  ...['reader.png','reader-mobile.png','editions.png'].map(name=>['docs/images/'+name,'assets/'+name]),
  ['samples/maltese-falcon/excerpt.txt','samples/excerpt.txt'],
]);
const manifest = JSON.parse(await readFile('samples/maltese-falcon/manifest.json','utf8'));
for (const provider of ['breeze','qwen','inworld']) for (const extension of ['mp3','json']) {
  const name = provider+'.'+extension, source = 'samples/maltese-falcon/'+name;
  const bytes = await readFile(source), expected = manifest.files[name];
  if (bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw new Error('Sample checksum mismatch: '+name);
  files.set(source,'samples/'+name);
}
await rm(output,{recursive:true,force:true});
await mkdir(output,{recursive:true});
for (const [source,destination] of files) {const path=join(output,destination);await mkdir(dirname(path),{recursive:true});await copyFile(source,path);}
await writeFile(join(output,'.nojekyll'),'');
await writeFile(join(output,'revision.json'),JSON.stringify({source:process.env.GITHUB_SHA??'local',files:[...files.values()]},null,2)+'\n');
console.log('Built the public landing page and three verified audio editions in .site-output/.');
