import { mkdir, readFile, writeFile, rename, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, fictionUrl, parseFiction, extractChapter, extractorVersion, type Chapter, type Fiction, type ChapterLink, type ChapterArchive, type ImageRef } from './pages.js';
import { imageClient, verifyImage, type GetPage, type GetImage } from './network.js';
export { httpClient } from './network.js';
export type { GetPage } from './network.js';
export async function atomicFile(path: string, value: string | Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, value, { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export const atomicJson = (path: string, value: unknown) => atomicFile(path, JSON.stringify(value, null, 2) + '\n');
export async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export interface Manifest {
  schemaVersion: 1 | 2; fiction: Fiction; current: Record<string, string>; checkedAt: string; complete: boolean;
  archive?: ChapterLink[]; details?: Record<string, string>; history?: Record<string, string[]>; cover?: ImageRef; mediaErrors?: number;
}
export interface DownloadOptions { signal?: AbortSignal; refresh?: boolean; from?: number; to?: number; reprocess?: boolean; getImage?: GetImage }
export function mergeArchive(previous: ChapterLink[], current: ChapterLink[]): ChapterLink[] {
  const old: ChapterLink[] = previous.map(c => ({ ...c, availability: 'removed' as ChapterLink['availability'] }));
  for (let i = 0; i < current.length; i++) {
    const chapter = current[i]!; const found = old.findIndex(c => c.chapterId === chapter.chapterId);
    if (found >= 0) old[found] = { ...chapter }; else {
      const next = current.slice(i + 1).map(c => old.findIndex(o => o.chapterId === c.chapterId)).find(index => index >= 0);
      old.splice(next ?? old.length, 0, { ...chapter });
    }
  }
  return old.map((c, i) => ({ ...c, sequence: i + 1 }));
}
async function verifiedChapter(directory: string, id: string, key: string, fictionId: string): Promise<Chapter> {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid saved revision.');
  const chapter = await readJson<Chapter>(join(directory, 'revisions', `${key}.json`));
  if (!chapter || chapter.fictionId !== fictionId || chapter.chapterId !== id || hash(chapter.text) !== chapter.contentHash || hash(JSON.stringify(chapter)) !== key) throw new Error('Saved chapter failed its integrity check.');
  return chapter;
}
export async function sync(root: string, value: string, get: GetPage, options: DownloadOptions = {}) {
  const identity = fictionUrl(value); const directory = join(root, `rr-${identity.id}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'writer.lock');
  const handle = await open(lock, 'wx', 0o600).catch(() => { throw new Error('This fiction is locked. Stop its other writer before removing writer.lock.'); });
  try {
    await handle.writeFile(`${process.pid}\n`);
    const source = await get(identity.url); const fiction = parseFiction(source, identity.url);
    if (options.from !== undefined && options.from > fiction.chapters.length) throw new Error('--from is beyond the table of contents.');
    const previous = await readJson<Manifest>(join(directory, 'manifest.json'));
    const current = { ...previous?.current }; const details = { ...previous?.details }; const history = { ...previous?.history };
    let previousArchive = previous?.archive ?? previous?.fiction.chapters ?? [];
    // Recover legacy orphaned pointers left behind by earlier table-of-contents updates.
    for (const [id, key] of Object.entries(current)) if (!previousArchive.some(c => c.chapterId === id)) {
      const chapter = await verifiedChapter(directory, id, key, fiction.fictionId);
      previousArchive = [...previousArchive, chapter].sort((a,b) => a.sequence-b.sequence);
    }
    const archive = mergeArchive(previousArchive, fiction.chapters);
    const manifest: Manifest = { schemaVersion: 2, fiction, current, details, history, archive, checkedAt: new Date().toISOString(), complete: false };
    for (const name of ['revisions','sources','records','assets','snapshots']) await mkdir(join(directory, name), { recursive: true, mode: 0o700 });
    if (previous) await atomicJson(join(directory, 'snapshots', `${hash(JSON.stringify(previous))}.json`), previous);
    await atomicFile(join(directory, 'sources', `${hash(source)}.html`), source);
    const getImage = options.getImage ?? imageClient(options.signal);
    const imageCache = new Map<string, ImageRef>();
    const fallbackImages = new Map<string, ImageRef>();
    if (previous?.cover?.asset) fallbackImages.set(previous.cover.url, previous.cover);
    const saveImage = async (ref: ImageRef): Promise<ImageRef> => {
      options.signal?.throwIfAborted();
      const cached = imageCache.get(ref.url); if (cached) return { ...cached, alt: ref.alt, section: ref.section };
      try { const data = await getImage(ref.url); const mime = verifyImage(data.bytes); const asset = hash(data.bytes); await atomicFile(join(directory,'assets',asset),data.bytes); const saved = { ...ref, asset, mime }; imageCache.set(ref.url,saved); return saved; }
      catch (error) {
        options.signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : 'Image download failed.';
        const fallback = fallbackImages.get(ref.url);
        if (fallback?.asset) {
          const bytes = await readFile(join(directory,'assets',fallback.asset)).catch(()=>undefined);
          if (bytes && hash(bytes) === fallback.asset) return { ...fallback, alt: ref.alt, section: ref.section, error: `Using saved image. ${message}` };
        }
        return { ...ref, error: message };
      }
    };
    if (fiction.coverUrl) manifest.cover = await saveImage({ url: fiction.coverUrl, alt: fiction.title, section: 'cover' });
    await atomicJson(join(directory, 'manifest.json'), manifest);
    let downloaded = 0, reused = 0, reprocessed = 0;
    for (const link of archive) {
      options.signal?.throwIfAborted();
      const remote = fiction.chapters.find(c => c.chapterId === link.chapterId);
      const selected = remote && remote.sequence >= (options.from ?? 1) && remote.sequence <= (options.to ?? Infinity) && remote.availability !== 'locked';
      let chapter = current[link.chapterId] ? await verifiedChapter(directory, link.chapterId, current[link.chapterId]!, fiction.fictionId) : undefined;
      if (details[link.chapterId] && !/^[a-f0-9]{64}$/.test(details[link.chapterId]!)) throw new Error('Invalid archive record pointer.');
      let record = details[link.chapterId] ? await readJson<ChapterArchive>(join(directory, 'records', `${details[link.chapterId]}.json`)) : undefined;
      if (record && hash(JSON.stringify(record)) !== details[link.chapterId]) throw new Error('Archive record failed its integrity check.');
      if (chapter && !record) {
        // Make pre-upgrade text revisions browsable without claiming original HTML exists.
        const escaped = chapter.text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
        record = { extractorVersion: 1, chapter, sourceHash: '', html: '<p>'+escaped.replaceAll('\n\n','</p><p>').replaceAll('\n','<br>')+'</p>', before:'', after:'', images:[] };
        const key = hash(JSON.stringify(record)); await atomicJson(join(directory,'records',`${key}.json`),record);
        details[link.chapterId] = key; history[link.chapterId] = [key];
      }
      if (record) for (const image of record.images) if (image.asset) fallbackImages.set(image.url,image);
      let html: string | undefined;
      if (selected && (!chapter || options.refresh || !record?.sourceHash)) { html = await get(link.url); downloaded++; }
      else if (chapter && record?.sourceHash && (options.reprocess || record.extractorVersion !== extractorVersion || record.images.some(image => image.error))) {
        html = await readFile(join(directory,'sources',`${record.sourceHash}.html`),'utf8');
        if (hash(html) !== record.sourceHash) throw new Error('Saved HTML failed its integrity check.');
        reprocessed++;
      }
      if (html !== undefined) {
        record = extractChapter(html, fiction.fictionId, link); chapter = record.chapter;
        if (record.images.length > 200) throw new Error('Chapter exceeds the 200 image limit.');
        for (let i = 0; i < record.images.length; i++) record.images[i] = await saveImage(record.images[i]!);
        await atomicFile(join(directory,'sources',`${record.sourceHash}.html`),html);
        const key = hash(JSON.stringify(chapter)); await atomicJson(join(directory,'revisions',`${key}.json`),chapter); current[link.chapterId] = key;
        const recordKey = hash(JSON.stringify(record)); await atomicJson(join(directory,'records',`${recordKey}.json`),record);
        const revisions = history[link.chapterId] ?? (details[link.chapterId] ? [details[link.chapterId]!] : []);
        history[link.chapterId] = [...new Set([...revisions,recordKey])]; details[link.chapterId] = recordKey;
        await atomicJson(join(directory,'manifest.json'),manifest);
      } else if (chapter) reused++;
    }
    const all: Chapter[] = [];
    let mediaErrors = manifest.cover?.error ? 1 : 0;
    for (const link of archive) if (current[link.chapterId]) {
      const chapter = await verifiedChapter(directory,link.chapterId,current[link.chapterId]!,fiction.fictionId);
      all.push({ ...chapter, sequence: link.sequence });
      if (details[link.chapterId]) { const record = await readJson<ChapterArchive>(join(directory,'records',`${details[link.chapterId]}.json`)); mediaErrors += record?.images.filter(i => i.error).length ?? 0; }
    }
    const unlocked = fiction.chapters.filter(c => c.availability !== 'locked');
    manifest.complete = unlocked.every(c => !!current[c.chapterId]); manifest.mediaErrors = mediaErrors;
    // A last successful export stays intact throughout failed refreshes.
    await atomicJson(join(directory,'chapters.json'),all);
    await atomicJson(join(directory,'manifest.json'),manifest);
    await atomicJson(join(directory,'snapshots',`${hash(JSON.stringify(manifest))}.json`),manifest);
    return { fictionId: fiction.fictionId, title: fiction.title, downloaded, reprocessed, reused, available: unlocked.length, locked: fiction.chapters.length-unlocked.length, removed: archive.filter(c=>c.availability==='removed').length, saved: all.length, mediaErrors, complete: manifest.complete, export: join(directory,'chapters.json') };
  } finally { await handle.close(); await rm(lock,{force:true}); }
}
