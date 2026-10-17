import { join } from 'node:path';
import { Store } from './store.js';
import type { Book } from './book.js';
import type { LibraryJob } from './library-queue.js';

export type RepairStatus = {
  title: string; detail: string; updatedAt: string; status: string; completed: number; total: number;
  chapters: { id: string; title: string; state: string; label: string }[];
};
/** Read-only presentation of owner-scoped jobs. Never exposes casting evidence or spoilers. */
export async function repairStatus(fictions: string, story: string, jobs: LibraryJob[], chapters: { chapterId: string; title: string }[]): Promise<RepairStatus | null> {
  const root = new Store(join(fictions, story));
  const job = jobs.find(value => value.story === story && value.repair);
  if (!job) {
    const review = await root.read<{ status?: string; audioRegenerationAuthorized?: boolean; reviewedAt?: string }>('casting-review.json');
    if (review?.status !== 'reviewed-plan-not-rendered' || review.audioRegenerationAuthorized !== false) return null;
    return { title: 'Casting reviewed', detail: 'Recast plan saved. Audio regeneration is not queued.', updatedAt: review.reviewedAt ?? '', status: 'reviewed', completed: 0, total: 0, chapters: [] };
  }
  const book = await root.read<Book>('book.json');
  const published = book?.editions.qwen?.chapters ?? [];
  const phase = job.phase;
  const activeLabel = phase.startsWith('Assigning speakers') ? 'Reanalyzing dialogue and casting'
    : phase.startsWith('Generating') ? 'Generating audio'
    : phase.startsWith('Checking and assembling') ? 'Checking audio'
    : phase.startsWith('Publishing') ? 'Publishing updated audio' : 'Preparing updated audio';
  const items = [];
  for (const chapterId of job.chapters ?? Object.keys(job.repair!.originals)) {
    const current = published.find(c => c.id === chapterId);
    // A changed assembly alone is not proof that this repair published it.
    const delivery = current && await root.read<{ chapters: { assembly: string }[] }>(`deliveries/auto-${job.id}-${current.sequence}/manifest.json`);
    const done = !!current && !!delivery?.chapters.some(c => c.assembly === current.assembly);
    const active = chapterId === job.currentChapter;
    const state = done ? 'published' : job.status === 'cancelled' ? 'cancelled' : active && job.status === 'failed' ? 'failed' : active && job.status === 'running' ? 'running' : 'queued';
    const label = done ? 'Updated audio ready' : job.status === 'cancelled' ? 'Repair cancelled' : active && job.status === 'failed' ? 'Needs review' : active && job.status === 'waiting' ? 'Waiting for audio worker' : active && job.status === 'running' ? activeLabel : 'Queued for reanalysis and recasting';
    items.push({ id: chapterId, title: chapters.find(c => c.chapterId === chapterId)?.title ?? current?.title ?? 'Chapter', state, label });
  }
  const completed = items.filter(c => c.state === 'published').length;
  const status = completed === items.length ? 'complete' : job.status;
  const title = status === 'cancelled' ? 'Audio repair cancelled' : status === 'complete' ? 'Audio repair complete' : status === 'failed' ? 'Audio repair needs review' : status === 'queued' ? 'Audio repair queued' : status === 'waiting' ? 'Audio repair waiting' : 'Audio repair in progress';
  const active = items.find(c => c.id === job.currentChapter && c.state !== 'published');
  const detail = status === 'cancelled' ? 'Repair stopped. Published updates and existing audio are kept.' : job.cancel ? 'Stopping after the current passage. Published updates are kept.' : status === 'complete' ? 'Updated chapters are ready to listen.' : status === 'failed' ? 'A chapter needs review before repair can continue. Existing audio remains available.' : active ? `${active.title} · ${active.label}` : 'Chapters will be reanalyzed, recast, and regenerated in reading order. Existing audio remains available.';
  return { title, detail, status, updatedAt: job.updatedAt, completed, total: items.length, chapters: items };
}
