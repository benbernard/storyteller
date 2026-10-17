import { chapterSchema, type Chapter } from './schema.js';
import { Store, fingerprint, sha } from './store.js';
export type SourceIndex = { schemaVersion: 1; fictionId: string; chapters: { id: string; sequence: number; revisions: string[]; current: string }[] };
export async function ingestLocal(store: Store, story: string, input: unknown) {
  const chapter = chapterSchema.parse(input);
  if (chapter.fictionId !== story || sha(chapter.text) !== chapter.contentHash) throw new Error('Downloaded chapter integrity failure');
  const index = await store.read<SourceIndex>('index.json') ?? { schemaVersion: 1, fictionId: story, chapters: [] };
  if (index.fictionId !== story) throw new Error('Fiction identity mismatch');
  if (index.chapters.some(c => c.sequence === chapter.sequence && c.id !== chapter.chapterId)) throw new Error('Chapter ordering changed; review before regenerating');
  let entry = index.chapters.find(c => c.id === chapter.chapterId);
  if (entry && entry.sequence !== chapter.sequence) throw new Error('Chapter ordering changed; review before regenerating');
  if (entry) {
    const old = await store.read<Chapter>(`sources/${entry.current}.json`);
    if (old && fingerprint({ ...old, retrievedAt: '' }) === fingerprint({ ...chapter, retrievedAt: '' })) return entry.current;
  }
  const source = await store.object('sources', chapter);
  if (!entry) { entry = { id: chapter.chapterId, sequence: chapter.sequence, revisions: [], current: source }; index.chapters.push(entry); }
  if (!entry.revisions.includes(source)) entry.revisions.push(source); entry.current = source;
  index.chapters.sort((a, b) => a.sequence - b.sequence); await store.write('index.json', index); return source;
}
