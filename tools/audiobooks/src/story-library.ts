import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store, sha } from './store.js';
import { type Book } from './book.js';
import { type Follow, type LibraryJob } from './library-queue.js';
export type ArchiveChapter = { chapterId: string; sequence: number; title: string; url: string; availability?: string };
export type ArchiveManifest = { fiction: { fictionId: string; title: string; author?: string; description?: string; status?: string; url: string; chapters: ArchiveChapter[] }; current: Record<string, string>; archive?: ArchiveChapter[]; checkedAt: string; cover?: { asset?: string; mime?: string } };
export async function archiveManifest(root: string, story: string) {
  if (!/^rr-\d+$/.test(story)) throw new Error('not_found');
  return new Store(join(root, story)).read<ArchiveManifest>('manifest.json');
}
export async function storyLibrary(root: string, fictions: string, follows: Follow[], jobs: LibraryJob[]) {
  const names = await readdir(root).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
  const stories = [];
  for (const story of names.filter(n => /^rr-\d+$/.test(n))) {
    const manifest = await archiveManifest(root, story); if (!manifest) continue;
    const book = await new Store(join(fictions, story)).read<Book>('book.json');
    const chapters = (manifest.archive ?? manifest.fiction.chapters).map(chapter => ({ ...chapter, downloaded: !!manifest.current[chapter.chapterId],
      editions: Object.entries(book?.editions ?? {}).filter(([, e]) => e.chapters.some(c => c.id === chapter.chapterId)).map(([edition]) => edition) }));
    const follow = follows.find(f => f.story === story), job = jobs.find(j => j.story === story);
    stories.push({ id: story, title: manifest.fiction.title, author: manifest.fiction.author ?? '', description: manifest.fiction.description ?? '',
      status: manifest.fiction.status ?? '', url: manifest.fiction.url, checkedAt: manifest.checkedAt,
      hasCover: !!manifest.cover?.asset, chapters, follow: follow ? { enabled: follow.enabled, mode: follow.mode, buffer: follow.buffer, intervalHours: follow.intervalHours, nextCheck: follow.nextCheck } : null,
      job: job ? publicJob(job) : null });
  }
  return stories;
}
export function publicJob(job: LibraryJob) { const { owner, bookorbit, ...value } = job; return value; }
export async function cover(root: string, story: string) {
  const manifest = await archiveManifest(root, story), asset = manifest?.cover?.asset;
  if (!asset || !/^[a-f0-9]{64}$/.test(asset) || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(manifest!.cover!.mime ?? '')) throw new Error('not_found');
  const bytes = await readFile(join(root, story, 'assets', asset)); if (sha(bytes) !== asset) throw new Error('Cover integrity failure');
  return { bytes, mime: manifest!.cover!.mime! };
}
