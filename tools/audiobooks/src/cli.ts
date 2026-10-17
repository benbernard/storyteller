import { parseArgs } from 'node:util';
import { readFile, rm, mkdir, copyFile, rename, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Pipeline } from './pipeline.js';
import { prepareBook, publishBook, editionSchema } from './book.js';
import { Store, sha } from './store.js';
import { ElevenLabs, Budget, renderSegment, type Ledger } from './audio.js';
import { auditionSegment } from './audition.js';
import { chapterSchema, configSchema, analysisSchema, voiceSchema, position, id,
  type Assembly } from './schema.js';

const HELP = `Audiobook batches

All commands: --state DIR (one private directory per fiction).
  schema --kind chapter|config|analysis       Print the JSON input contract
  hash --file chapter.txt                     Hash exact source bytes
  configure --file fiction.json               Save a versioned fiction configuration
  ingest --file chapters.json                 Import one chapter or an ordered array
  analyze-import --chapter ID --file spans.json
  prepare --batch ID [--chapters ID,ID]       Analyze, cast and estimate before speech
  publish --batch ID --edition EDITION --title TITLE [--author NAME]
  run --batch ID [--purpose pilot|batch|repair] [--chapters ID,ID]
  experiments --batch ID [--chapters ID,ID]    Compare four policies under one budget
  status                                     Show neutral batch status and costs
  export --batch ID --output DIR              Copy verified chapter audio and playlist
  progress --through N                        Mark chapter N fully heard
  reviews                                    Open up to five eligible questions
  resolve --review ID                         Resolve a heard review item
  locate --assembly HASH --seconds N          Open the segment heard at that time
  correct --assembly HASH --file edit.json    Record a span repair; then run a new batch
  voice --character ID --file change.json     Record an effective voice version
  audition --batch ID --file sample.json      Render an audition with a bounded budget
  unlock                                     Remove a stale lock after verifying no worker

Paid calls read ELEVENLABS_API_KEY and OPENAI_API_KEY from the environment.
Production batches require a policy selected after the listening pilot.
Do not remove a writer lock while a batch is running.
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    state: { type: 'string', default: process.env.AUDIOBOOK_STATE ?? '/state' },
    edition: { type: 'string' }, title: { type: 'string' }, author: { type: 'string' },
    file: { type: 'string' }, kind: { type: 'string' }, chapter: { type: 'string' }, chapters: { type: 'string' },
    batch: { type: 'string' }, purpose: { type: 'string', default: 'batch' }, through: { type: 'string' },
    assembly: { type: 'string' }, seconds: { type: 'string' }, character: { type: 'string' },
    output: { type: 'string' }, review: { type: 'string' }, help: { type: 'boolean' },
  } });
  const command = positionals[0];
  if (!command || values.help || command === 'help') { process.stdout.write(HELP); return; }
  const required = (name: keyof typeof values): string => {
    const value = values[name]; if (typeof value !== 'string' || !value) throw new Error(`--${name} is required`); return value;
  };
  const file = async () => JSON.parse(await readFile(required('file'), 'utf8')) as unknown;
  const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  if (command === 'schema') {
    const schemas = { chapter: chapterSchema, config: configSchema, analysis: analysisSchema };
    const kind = z.enum(['chapter', 'config', 'analysis']).parse(required('kind'));
    output(z.toJSONSchema(schemas[kind])); return;
  }
  if (command === 'hash') { output({ contentHash: sha(await readFile(required('file'))) }); return; }
  const store = new Store(resolve(required('state'))), pipeline = new Pipeline(store);
  if (command === 'unlock') { await rm(store.path('writer.lock'), { recursive: true, force: true }); output({ unlocked: true }); return; }
  await store.lock(async () => {
    switch (command) {
      case 'configure': output({ config: await pipeline.configure(await file()) }); break;
      case 'ingest': {
        const input = await file(), records = Array.isArray(input) ? input : [input];
        const validated = records.map(r => chapterSchema.parse(r)).sort((a, b) => a.sequence - b.sequence);
        const revisions = []; for (const chapter of validated) revisions.push(await pipeline.ingest(chapter));
        output({ revisions }); break;
      }
      case 'analyze-import': output({ analysis: await pipeline.importAnalysis(id.parse(required('chapter')), analysisSchema.parse(await file())) }); break;
      case 'prepare': output(await prepareBook(pipeline, id.parse(required('batch')), values.chapters?.split(',').map(c => id.parse(c)))); break;
      case 'publish': output(await publishBook(pipeline, id.parse(required('batch')), editionSchema.parse(required('edition')), required('title'), values.author ?? '')); break;
      case 'run': output(await pipeline.run(id.parse(required('batch')), new ElevenLabs(),
        z.enum(['pilot', 'batch', 'repair']).parse(values.purpose), values.chapters?.split(',').map(c => id.parse(c)))); break;
      case 'experiments': output(await pipeline.experiments(id.parse(required('batch')), new ElevenLabs(),
        values.chapters?.split(',').map(c => id.parse(c)))); break;
      case 'progress': await pipeline.progress(position.parse({ chapter: Number(required('through')), offset: 0 })); output({ saved: true }); break;
      case 'reviews': output(await pipeline.reviews()); break;
      case 'resolve': {
        const key = required('review');
        const visible = await pipeline.reviews();
        if (!visible.items.some(r => r.id === key)) throw new Error('Review is sealed, resolved, or outside the current queue');
        const reviews = await store.read<{ id: string; status: string }[]>('reviews.json') ?? [];
        reviews.find(r => r.id === key)!.status = 'resolved';
        await store.write('reviews.json', reviews); output({ resolved: true }); break;
      }
      case 'locate': output(await pipeline.locate(hash(required('assembly')), Number(required('seconds')))); break;
      case 'correct': output(await pipeline.correct(hash(required('assembly')), await file())); break;
      case 'voice': {
        const change = z.object({ voice: voiceSchema, from: position, reason: z.string().min(1) }).strict().parse(await file());
        output(await pipeline.changeVoice(id.parse(required('character')), change.voice, change.from, change.reason)); break;
      }
      case 'status': {
        const entries = await readdir(store.path('jobs')).catch(() => [] as string[]);
        const batches = [];
        for (const entry of entries) {
          const job = await store.read<{ status: string; chapters: { sequence: number; status: string; assembly?: string }[] }>(`jobs/${entry}/job.json`);
          const ledger = await store.read<Ledger>(`jobs/${entry}/ledger.json`);
          batches.push({ id: entry, status: job?.status ?? 'audition', chapters: job?.chapters.map(c => ({ sequence: c.sequence, status: c.status, assembly: c.assembly })),
            reservedCharacters: ledger?.charges.reduce((n, c) => n + c.characters, 0) ?? 0,
            estimatedUsdUpperBound: ledger?.charges.reduce((n, c) => n + c.estimatedUsd, 0) ?? 0,
            knownBilledCredits: ledger?.charges.reduce((n, c) => n + (c.billedCredits ?? 0), 0) ?? 0 });
        }
        output({ ...(await pipeline.status()), batches }); break;
      }
      case 'audition': {
        const config = await pipeline.config(), batch = id.parse(required('batch'));
        const segment = auditionSegment(await file(), config);
        const budget = new Budget(store, batch, config, await store.read<Ledger>(`jobs/${batch}/ledger.json`) ?? { charges: [] });
        const asset = await renderSegment(store, segment, config, budget, new ElevenLabs(), 0, undefined, 'audition');
        output({ sampleAsset: asset.fingerprint, audio: store.path(`assets/${asset.fingerprint}/audio.mp3`) }); break;
      }
      case 'export': {
        const batch = id.parse(required('batch'));
        const delivery = await store.read<{ chapters: { sequence: number; assembly: string }[] }>(`deliveries/${batch}/manifest.json`);
        if (!delivery) throw new Error('No completed delivery for this batch');
        const destination = resolve(required('output'));
        const temporary = destination + `.pending-${randomUUID()}`;
        await mkdir(temporary, { recursive: true, mode: 0o700 });
        try {
          const playlist: string[] = ['#EXTM3U'];
          const metadata = [];
          for (const chapter of delivery.chapters) {
            const assembly = (await store.read<Assembly>(`assemblies/${chapter.assembly}/metadata.json`))!;
            const audioPath = store.path(`assemblies/${assembly.id}/chapter.mp3`);
            if (sha(await readFile(audioPath)) !== assembly.checksum) throw new Error('Delivery checksum mismatch');
            const name = `chapter-${String(chapter.sequence).padStart(4, '0')}.mp3`;
            await copyFile(audioPath, resolve(temporary, name));
            playlist.push(`#EXTINF:${assembly.duration.toFixed(3)},Chapter ${chapter.sequence}`, name);
            metadata.push({ sequence: chapter.sequence, file: name, assembly: assembly.id, sha256: assembly.checksum });
          }
          const { atomic } = await import('./store.js');
          await atomic(resolve(temporary, 'playlist.m3u'), playlist.join('\n') + '\n');
          await atomic(resolve(temporary, 'delivery.json'), JSON.stringify({ batch, chapters: metadata }, null, 2));
          await rename(temporary, destination);
          output({ directory: destination, chapters: metadata.length });
        } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
        break;
      }
      default: throw new Error('Unknown command; use --help');
    }
  });
}
const hash = (input: string) => z.string().regex(/^[a-f0-9]{64}$/).parse(input);
main().catch(error => {
  // Provider bodies, headers, credentials and source text never appear in errors.
  const message = error instanceof z.ZodError ? 'Invalid input schema; use the schema command to inspect the contract' : (error as Error).message;
  process.stderr.write(message.replace(/(?:sk-|xi_)[A-Za-z0-9_-]+/g, '[redacted]') + '\n'); process.exitCode = 1;
});
