import { reconcileSelection } from './bookorbit-selection.js';
import { bookOrbitChapters } from './bookorbit-ingest.js';
import { spawn } from 'node:child_process';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { LibraryQueue, type LibraryJob } from './library-queue.js';
import { archiveManifest } from './story-library.js';
import { Store, fingerprint } from './store.js';
import { ingestLocal, type SourceIndex } from './local-ingest.js';
import { poolSchema, saveLocalCast, extendLocalCast, renderCast, type LocalCast } from './local-cast.js';
import { type Chapter, type Analysis, type Cast } from './schema.js';
import { type Book, publishBook } from './book.js';
import { Pipeline } from './pipeline.js';
import { MacClient, MacUnavailable } from './mac-client.js';
import { chapterPresentation, presentationCast } from './local-presentation.js';
import { localVoiceAt } from './local-cast.js';
import { analyzeFrontier, frontierPolicySchema, isCurrentFrontierAnalysis } from './frontier-analysis.js';
import { applyFrontierProfiles } from './local-cast.js';
export type WorkerPaths = { state: string; fictions: string; archive: string; work: string; pool: string; credential: string; downloader: string; renderer: string; bookorbitSocket?: string; bookorbitOwner?: string };
export function desiredChapters(index: SourceIndex, book: Book | undefined, job: LibraryJob, completed: Record<string, boolean>) {
  if (job.mode === 'download') return [];
  const firstUnread = index.chapters.findIndex(c => !completed[`${job.story}:${c.id}`]);
  const target = job.mode === 'all' ? index.chapters : firstUnread < 0 ? [] : index.chapters.slice(0, firstUnread + job.buffer);
  for (const c of target) { const published = book?.editions.qwen?.chapters.find(p => p.id === c.id); if (published && published.source !== c.current) throw new Error(`Published text changed in chapter ${c.sequence}; review a repair before replacing its audio`); }
  return target.filter(c => !book?.editions.qwen?.chapters.some(p => p.id === c.id)).map(c => c.id);
}
async function command(executable: string, args: string[], env: NodeJS.ProcessEnv = process.env, cancelled: () => boolean = () => false) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); let error = '';
    // Output may contain source text; the job exposes a bounded operational error only.
    child.stdout.on('data', () => {}); child.stderr.on('data', part => { error = (error + String(part)).slice(-3000); });
    const timer = setInterval(() => { if (cancelled()) child.kill('SIGTERM'); }, 1000);
    child.on('error', e => { clearInterval(timer); reject(e); });
    child.on('close', code => { clearInterval(timer); if (code === 0) resolve(); else reject(new Error(`Local command failed (${code ?? 'stopped'}): ${error.slice(-600)}`)); });
  });
}
export async function runLibraryJob(paths: WorkerPaths, queue: LibraryQueue, job: LibraryJob, signal?: AbortSignal) {
  const root = new Store(join(paths.fictions, job.story));
  return root.lock(async () => {
  const cancelled = () => !!queue.get(job.id)?.cancel || !!signal?.aborted;
  const phase = (value: string) => { job.phase = value; queue.update(job); if (cancelled()) throw new Error('Job cancelled'); };
  let title: string, author: string, input: unknown[];
  if (job.repair) {
    const book = await root.read<Book>('book.json'); if (!book) throw new Error('Repair book is missing');
    title = book.title; author = book.author; input = [];
  } else if (job.bookorbit && !job.story.startsWith('rr-')) {
    phase('Reading the current BookOrbit file');
    input = await bookOrbitChapters(job.bookorbit, job.story); title = job.bookorbit.title; author = job.bookorbit.author;
  } else {
    phase('Checking Royal Road and downloading new chapters');
    await command(process.execPath, [paths.downloader, 'download', job.url], { ...process.env, ROYAL_ROAD_STATE: paths.archive }, cancelled);
    const manifest = await archiveManifest(paths.archive, job.story); if (!manifest) throw new Error('Downloaded story manifest is missing');
    title = manifest.fiction.title; author = manifest.fiction.author ?? '';
    input = JSON.parse(await readFile(join(paths.archive, job.story, 'chapters.json'), 'utf8')) as unknown[];
  }
  for (const chapter of input) await ingestLocal(root, job.story, chapter);
  const index = (await root.read<SourceIndex>('index.json'))!;
  const user = await new Store(paths.state).read<{ completed: Record<string, boolean> }>(`users/${job.owner}.json`);
  job.chapters ??= desiredChapters(index, await root.read<Book>('book.json'), job, user?.completed ?? {}); queue.update(job);
  if (!job.chapters.length) { phase(job.mode === 'download' ? 'New chapter text is saved' : 'The requested chapters already have Qwen audio'); return; }
  const savedPolicy = await root.read<Record<string, unknown>>('frontier-policy.json');
  const analysisPolicy = frontierPolicySchema.parse({ ...savedPolicy, ...(process.env.AUDIOBOOK_ANALYSIS_MODEL ? { model: process.env.AUDIOBOOK_ANALYSIS_MODEL } : {}) });
  const pool = poolSchema.parse(JSON.parse(await readFile(paths.pool, 'utf8')));
  const mac = new MacClient(paths.credential, job.id); await mac.initialize();
  phase('Waiting for the Mac audio worker'); await mac.claim();
  let leaseFailure: Error | undefined;
  const renewal = setInterval(() => { void mac.claim().catch((e: Error) => { leaseFailure = e; }); }, 30000);
  let activeDirectory: string | undefined;
  const cancellationWatch = setInterval(() => { if ((cancelled() || leaseFailure) && activeDirectory) void writeFile(join(activeDirectory, 'cancel.requested'), '').catch(() => {}); }, 1000);
  try {
    for (const chapterId of job.chapters) {
      if (leaseFailure) throw leaseFailure;
      const entry = index.chapters.find(c => c.id === chapterId); if (!entry) throw new Error('Queued chapter was removed; review the source change');
      job.currentChapter = chapterId;
      const currentBook = await root.read<Book>('book.json'); const published = currentBook?.editions.qwen?.chapters.find(c => c.id === chapterId);
      if (job.repair) {
        if (published?.assembly !== job.repair.originals[chapterId]) {
          const delivery = await root.read<{ chapters: { assembly: string }[] }>(`deliveries/auto-${job.id}-${entry.sequence}/manifest.json`);
          if (delivery?.chapters.some(c => c.assembly === published?.assembly)) continue;
          throw new Error('Published audio changed after repair was queued');
        }
        if (!published || published.source !== entry.current) throw new Error('Repair requires unchanged reviewed source');
      } else if (published?.source === entry.current) continue;
      const chapter = (await root.read<Chapter>(`sources/${entry.current}.json`))!;
      let roster = await root.read<Cast>('cast.json') ?? { schemaVersion: 1, members: [] };
      let cast = await root.read<LocalCast>('local-cast.json') ?? { schemaVersion: 1, model: 'qwen-base', revision: pool.revision, assignments: [] };
      const previous = await root.read<{ source: string; analysis: string; context: string }>(`heads/${chapterId}.json`);
      const context = await new Pipeline(root).earlierContext(chapter.sequence);
      if (previous && previous.source !== entry.current) throw new Error('Source revision needs a reviewed analysis repair');
      let analysis = previous && previous.context === context ? await root.read<Analysis>(`analyses/${previous.analysis}.json`) : undefined;
      if (!isCurrentFrontierAnalysis(analysis, analysisPolicy.model)) analysis = undefined;
      if (!analysis) {
        phase(`Assigning speakers with ${analysisPolicy.model} in chapter ${chapter.sequence}`);
        const result = await analyzeFrontier(root, chapter, roster, context, analysisPolicy); analysis = result.analysis;
        const reviewed = applyFrontierProfiles(cast, roster, analysis, result.profiles, chapter, pool, !!job.repair); cast = reviewed.cast; roster = reviewed.metadata;
        const extended = extendLocalCast(cast, roster, analysis, chapter, pool); cast = extended.cast;
        await saveLocalCast(root, cast); await root.object('cast-history', extended.metadata); await root.write('cast.json', extended.metadata);
        const key = await root.object('analyses', analysis);
        await root.write(`heads/${chapterId}.json`, { source: entry.current, analysis: key, context, dependency: analysis.fingerprint, castBefore: roster }); roster = extended.metadata;
      } else {
        // Importing a reviewed analysis never silently replaces its original cast.
        const extended = extendLocalCast(cast, roster, analysis, chapter, pool); cast = extended.cast; await saveLocalCast(root, cast);
        await root.object('cast-history', extended.metadata); await root.write('cast.json', extended.metadata);
      }
      const notes = await chapterPresentation(new Store(join(paths.archive, job.story)), chapter);
      cast = presentationCast(cast, chapter, pool, notes); await saveLocalCast(root, cast);
      const batch = `auto-${job.id}-${chapter.sequence}`; job.batch = batch;
      const directory = join(paths.work, job.id, chapterId); activeDirectory = directory; await mkdir(directory, { recursive: true, mode: 0o700 }); await rm(join(directory, 'cancel.requested'), { force: true });
      const castPath = join(directory, 'cast.json');
      const batchStore = new Store(directory); const existing = await batchStore.read<ReturnType<typeof renderCast>>('cast.json');
      const selectedCast = renderCast(cast, analysis, chapter);
      selectedCast.voices.narrator ??= localVoiceAt(cast, "narrator", { chapter: chapter.sequence, offset: chapter.text.length });
      if (notes.before || notes.after) selectedCast.voices["author-note"] = localVoiceAt(cast, "author-note", { chapter: chapter.sequence, offset: 0 });
      await batchStore.write("presentation.json", { [chapterId]: notes });
      if (existing && fingerprint({ model: existing.model, revision: existing.revision, voices: existing.voices }) !== fingerprint({ model: selectedCast.model, revision: selectedCast.revision, voices: selectedCast.voices })) throw new Error('Casting changed for this render; start a new job to preserve the earlier plan');
      if (!existing) await batchStore.write('cast.json', selectedCast);
      phase(`Preparing chapter ${chapter.sequence}`);
      await command('python3', [paths.renderer, 'prepare', '--state', root.root, '--directory', directory, '--cast', castPath, '--chapters', chapterId, '--batch', batch, '--presentation', join(directory, 'presentation.json'), '--reuse-root', paths.work]);
      phase(`Generating Qwen audio for chapter ${chapter.sequence}`);
      await command('python3', [paths.renderer, 'render', '--state', root.root, '--directory', directory, '--credential', paths.credential], { ...process.env, MAC_TTS_LEASE: job.id });
      phase(`Checking and assembling chapter ${chapter.sequence}`);
      await command('python3', [paths.renderer, 'assemble', '--state', root.root, '--directory', directory, '--batch', batch]);
      phase(`Publishing chapter ${chapter.sequence}`);
      await publishBook(new Pipeline(root), batch, 'qwen', title, author, true);
      job.completedChapters = (job.completedChapters ?? 0) + 1; queue.update(job);
      activeDirectory = undefined;
    }
    phase('Qwen chapters are ready to listen');
  } finally {
    clearInterval(renewal); clearInterval(cancellationWatch);
    // This header can stop only the model held by this job's lease.
    await mac.call('/v1/stop', {}).catch(() => {}); await mac.release().catch(() => {});
  }
  });
}
export async function runWorker(paths: WorkerPaths, signal: AbortSignal) {
  const queue = new LibraryQueue(paths.state), holder = randomUUID();
  let checking = false;
  const refresh = async () => {
    if (!paths.bookorbitSocket || !paths.bookorbitOwner || checking) return;
    checking = true;
    try { await reconcileSelection(paths.state, queue, paths.bookorbitSocket, paths.bookorbitOwner); }
    catch { console.error('BookOrbit selection check failed; retaining the last verified selection'); }
    finally { checking = false; }
  };
  await refresh();
  const selectionTimer = setInterval(() => { void refresh(); }, 60000);
  const leaseLost = new AbortController();
  const stopping = AbortSignal.any([signal, leaseLost.signal]);
  const heartbeat = setInterval(() => { try { if (!queue.lease(holder)) leaseLost.abort(); } catch { leaseLost.abort(); } }, 30000);
  try {
    while (!stopping.aborted) {
      if (!queue.lease(holder)) { await new Promise(r => setTimeout(r, 10000)); continue; }
      queue.schedule(); const job = queue.claim(holder);
      if (!job) { await new Promise(r => setTimeout(r, 5000)); continue; }
      try { await runLibraryJob(paths, queue, job, stopping); job.status = job.cancel ? 'cancelled' : 'complete'; delete job.error; }
      catch (error) {
        const message = (error as Error).message;
        if (stopping.aborted) { job.status = 'queued'; job.phase = 'Worker restarted; resuming from saved passages'; }
        else if (queue.get(job.id)?.cancel) { job.status = 'cancelled'; job.phase = 'Cancelled; completed audio is retained'; }
        else if (error instanceof MacUnavailable) { job.status = 'waiting'; job.phase = message; job.nextRun = Date.now() + 300000; }
        else { job.attempts++; job.status = 'failed'; job.error = message; job.phase = 'Needs attention before retrying'; }
      }
      if (!leaseLost.signal.aborted) queue.update(job);
    }
  } finally { clearInterval(heartbeat); clearInterval(selectionTimer); while (checking) await new Promise(r => setTimeout(r, 50)); queue.release(holder); queue.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  const abort = new AbortController(); for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => abort.abort());
  await runWorker({ state: process.env.LISTENER_STATE ?? '/listener', fictions: process.env.AUDIOBOOK_FICTIONS ?? '/fictions', archive: process.env.ROYAL_ROAD_ARCHIVE ?? '/archive',
    work: process.env.LOCAL_AUDIO_WORK ?? '/automation/jobs', pool: process.env.LOCAL_AUDIO_POOL ?? '/automation/pool.json', credential: process.env.MAC_TTS_CREDENTIAL ?? '/credential/client.json',
    bookorbitSocket: process.env.BOOKORBIT_AUDIO_SOCKET, bookorbitOwner: process.env.BOOKORBIT_LISTENER_OWNER,
    downloader: process.env.ROYAL_ROAD_CLI ?? '/royal-road/dist/cli.js', renderer: process.env.LOCAL_AUDIO_RENDERER ?? '/mac-tts/local_book.py' }, abort.signal);
}
