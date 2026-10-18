import {join} from 'node:path';

/** Availability must pass before either staged or live runtime activation. */
export async function afterPhonemePreflight(config,runtime,command,activate){
 const script=join(runtime,'tools/inworld-batch/phonemes.py');
 if(typeof config.phonemePython!=='string'||!config.phonemePython)throw Error('Configure phonemePython before installing an Inworld runtime');
 try{await command(config.phonemePython,[script,'--check-model'],{timeout:60000});}
 catch(error){throw Error('Pinned phoneme model preflight failed. Run the configured phonemePython with '+script+' --bootstrap-model, then retry installation. '+String(error.message));}
 return await activate();
}
