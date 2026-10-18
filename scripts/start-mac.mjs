import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
if((await import('node:fs')).existsSync('.env'))process.loadEnvFile('.env');
const home=resolve(process.env.MAC_TTS_HOME ?? 'data/mac-tts');
const child=spawn(process.execPath,['tools/mac-tts/dist/src/server.js'],{stdio:'inherit',env:{...process.env,MAC_TTS_HOME:home,MAC_TTS_BIND:'127.0.0.1',HF_HOME:resolve(home,'cache/huggingface')}});
for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>child.kill(s));
child.on('exit',code=>{process.exitCode=code ?? 1});child.on('error',e=>{throw e});
