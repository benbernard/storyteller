import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fictionUrl, parseFiction} from './pages.js';
import {httpClient, sync} from './download.js';
import {exportEpub} from './epub.js';
process.umask(0o077);
const abort = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => abort.abort());
try {
 const {positionals, values} = parseArgs({allowPositionals: true, options: {help:{type:'boolean'}, refresh:{type:'boolean'}, reprocess:{type:'boolean'}, from:{type:'string'}, to:{type:'string'}}});
 const [command, source] = positionals, root = process.env.ROYAL_ROAD_STATE ?? '/archive';
 const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
 const integer = (value: string | undefined) => {if(value === undefined) return undefined; if(!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Chapter bounds must be positive integers'); return Number(value);};
 if (!command || values.help || command === 'help') console.log('Royal Road downloader\n  inspect URL_OR_ID\n  download URL_OR_ID [--from N] [--to N] [--refresh] [--reprocess]\n  status URL_OR_ID\n  epub URL_OR_ID\nRepeat download to fetch missing chapters; chapters.json feeds the audiobook engine.');
 else if (!source) throw new Error('A fiction URL or ID is required');
 else if (command === 'inspect') {const url=fictionUrl(source).url; output(parseFiction(await httpClient()(url),url));}
 else if (command === 'download') {const from=integer(values.from),to=integer(values.to); if(from !== undefined && to !== undefined && from>to) throw new Error('--from must not exceed --to'); output(await sync(root,source,httpClient(2000,abort.signal),{from,to,refresh:values.refresh,reprocess:values.reprocess,signal:abort.signal}));}
 else if (command === 'epub') output(await exportEpub(root,'rr-'+fictionUrl(source).id,abort.signal));
 else if (command === 'status') output(JSON.parse(await readFile(join(root,'rr-'+fictionUrl(source).id,'manifest.json'),'utf8')) as unknown);
 else throw new Error('Unknown command; use --help');
} catch(error) {console.error(error instanceof Error ? error.message : 'Download failed');process.exitCode=1;}
