/** Pin a clean, committed runtime and install one persistent macOS job. */
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,dirname,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {afterPhonemePreflight} from './install-preflight.mjs';
const [configuration,label,codexBinary,mode]=process.argv.slice(2);
if(!configuration||!codexBinary||!/^[-a-zA-Z0-9.]+$/.test(label??'')||![undefined,'--stage-only'].includes(mode)||process.argv.length>6)throw Error('Usage: install-macos.mjs CONFIG LABEL CODEX_BINARY [--stage-only]');
if(process.platform!=='darwin')throw Error('This installer requires macOS');
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
function command(program,args,options={}){
 const result=spawnSync(program,args,{cwd:repo,encoding:'utf8',...options});
 if(result.status!==0)throw Error(program+' failed: '+String(result.stderr).slice(-1200));return result.stdout;
}
const source=command('git',['rev-parse','HEAD']).trim();
if(command('git',['status','--porcelain','--','tools/inworld-batch','tools/audiobooks','tools/mac-tts/acting-auditions/speech_parts.py']).trim())throw Error('Commit and validate runtime source before installation');
const config=JSON.parse(await fs.readFile(configuration,'utf8'));
for(const name of mode==='--stage-only'?[]:['supervisor.lock','worker.lock']){
 try{const pid=Number(await fs.readFile(join(config.root,name),'utf8'));process.kill(pid,0);throw Error('Stop this job before installing a runtime');}
 catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}
}
await fs.access(codexBinary,fs.constants.X_OK);
const runtime=join(config.root,'runtime-'+source),receipt=join(runtime,'source-commit.txt');
try{await fs.access(receipt);}catch(error){
 if(error.code!=='ENOENT')throw error;
 await fs.mkdir(runtime,{recursive:true,mode:0o700});
 const archive=spawnSync('git',['archive',source,'tools/inworld-batch','tools/audiobooks','tools/mac-tts/acting-auditions/speech_parts.py'],{cwd:repo,maxBuffer:32e6});
 if(archive.status!==0)throw Error('Cannot archive committed source');
 command('tar',['-xf','-','-C',runtime],{input:archive.stdout});
 command('pnpm',['install','--frozen-lockfile'],{cwd:join(runtime,'tools/audiobooks')});
 command('pnpm',['build'],{cwd:join(runtime,'tools/audiobooks')});
 await fs.writeFile(receipt,source+'\n',{mode:0o600});
}
if((await fs.readFile(receipt,'utf8')).trim()!==source)throw Error('Runtime source receipt differs');
await afterPhonemePreflight(config,runtime,command,async()=>{
if(mode==='--stage-only'){
 await fs.writeFile(join(config.root,'pending-runtime.json'),JSON.stringify({source,runtime,configuration:resolve(configuration),label,stagedAt:new Date().toISOString(),activeConfigurationChanged:false},null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({source,runtime,label,started:false,staged:true,configuration:resolve(configuration)}));
 process.exit(0);
}
const backup=join(config.root,'runtime-upgrades',source+'-'+Date.now());await fs.mkdir(backup,{recursive:true,mode:0o700});
await fs.copyFile(configuration,join(backup,'config-before.json'));
Object.assign(config,{sourceCommit:source,sourceRepository:'https://github.com/benbernard/storyteller',sourceRoot:runtime,planner:join(runtime,'tools/audiobooks/dist/inworld-plan.js'),analysisModule:join(runtime,'tools/audiobooks/dist/codex-analysis.js')});
await fs.writeFile(configuration+'.tmp',JSON.stringify(config,null,2)+'\n',{mode:0o600});await fs.rename(configuration+'.tmp',configuration);
const scratch=join(config.root,'tmp');await fs.mkdir(scratch,{recursive:true,mode:0o700});
const plistPath=join(homedir(),'Library/LaunchAgents',label+'.plist');
try{await fs.copyFile(plistPath,join(backup,'launch-agent-before.plist'));}catch(error){if(error.code!=='ENOENT')throw error;}
const plist={Label:label,ProgramArguments:['/usr/bin/caffeinate','-i','-s',process.execPath,join(runtime,'tools/inworld-batch/supervisor.mjs'),resolve(configuration)],WorkingDirectory:config.root,
 RunAtLoad:true,KeepAlive:{SuccessfulExit:false},StartInterval:600,ThrottleInterval:60,ProcessType:'Background',
 EnvironmentVariables:{PATH:process.env.PATH,HOME:homedir(),TMPDIR:scratch,CODEX_HOME:process.env.CODEX_HOME??join(homedir(),'.codex'),AUDIOBOOK_CODEX_BIN:resolve(codexBinary)},
 StandardOutPath:join(config.root,'launchd.log'),StandardErrorPath:join(config.root,'launchd-error.log')};
const xml=command('/usr/bin/plutil',['-convert','xml1','-o','-','-'],{input:JSON.stringify(plist)});
spawnSync('/bin/launchctl',['bootout',`gui/${process.getuid()}/${label}`]);
await fs.mkdir(dirname(plistPath),{recursive:true});await fs.writeFile(plistPath,xml,{mode:0o600});
command('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,plistPath]);
await fs.rm(join(config.root,'pending-runtime.json'),{force:true});
console.log(JSON.stringify({source,runtime,label,started:true,configuration:resolve(configuration)}));
});
