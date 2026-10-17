import { load } from 'cheerio';
import { Store, sha } from './store.js';
import { type Chapter } from './schema.js';
import { assignLocal, localVoiceAt, type LocalCast, type LocalPool } from './local-cast.js';

export type Presentation = { before: string; after: string; archiveRecord?: string };
export function noteText(html: string): string {
  const $ = load(html, {}, false);
  $('script, style, img, button, summary').remove();
  $('br').replaceWith('\n'); $('p, div, li, tr, blockquote, hr').append('\n\n');
  return $.text().replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
export async function chapterPresentation(archive: Store, chapter: Chapter): Promise<Presentation> {
  const manifest = await archive.read<{ details?: Record<string, string> }>('manifest.json');
  const key = manifest?.details?.[chapter.chapterId];
  if (!key) return { before: '', after: '' };
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid archive record');
  const record = await archive.read<{ chapter: Chapter; before: string; after: string }>(`records/${key}.json`);
  if (!record || sha(JSON.stringify(record)) !== key || record.chapter.chapterId !== chapter.chapterId || record.chapter.contentHash !== chapter.contentHash) throw new Error('Author notes do not match the reviewed chapter');
  return { before: noteText(record.before), after: noteText(record.after), archiveRecord: key };
}
export function presentationCast(saved: LocalCast, chapter: Chapter, pool: LocalPool, notes: Presentation): LocalCast {
  let cast = saved;
  if (!cast.assignments.some(a => a.role === 'narrator')) cast = assignLocal(cast, 'narrator', pool.narrator, { chapter: chapter.sequence, offset: 0 }, chapter.contentHash, chapter.title || chapter.text.slice(0, 100), 'Chapter announcement narrator');
  if (notes.before || notes.after) {
    const narrator = localVoiceAt(cast, 'narrator', { chapter: chapter.sequence, offset: chapter.text.length });
    if (!cast.assignments.some(a => a.role === 'author-note')) {
      const used = new Set(cast.assignments.map(a => a.voice.sha256));
      const voice = [...pool.voices, pool.anonymous].filter(v => v.sha256 !== narrator.sha256).sort((a, b) => Number(used.has(a.sha256)) - Number(used.has(b.sha256)))[0];
      if (!voice) throw new Error('Author notes require a voice distinct from the narrator');
      cast = assignLocal(cast, 'author-note', voice, { chapter: chapter.sequence, offset: 0 }, chapter.contentHash, (notes.before || notes.after).slice(0, 200), 'Separate Royal Road author-note voice');
    }
    if (localVoiceAt(cast, 'author-note', { chapter: chapter.sequence, offset: 0 }).sha256 === narrator.sha256) throw new Error('Author-note voice must differ from narrator');
  }
  return cast;
}
