import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { Store, sha } from './store.js';
import { Pipeline } from './pipeline.js';
import { plan } from './planner.js';
import { analyzeRemote, analysisFingerprint } from './analysis.js';
import { Budget, type Ledger } from './audio.js';
import { id, type Analysis, type Assembly, type Cast, type Config, type Correction } from './schema.js';

// Editions are publication identifiers, independent of the available generators.
export const editionSchema = id.refine(value => !Object.hasOwn(Object.prototype, value) && value !== 'prototype', 'Reserved edition name');
const knownEditionModels: Readonly<Record<string, string>> = {
  v3: 'eleven_v3', flash: 'eleven_flash_v2_5', qwen: 'qwen-base', chatterbox: 'chatterbox',
  breeze: 'breeze-tts-2', 'breeze-hybrid': 'breeze-qwen-hybrid',
};
export type Edition = z.infer<typeof editionSchema>;
export type Book = { schemaVersion: 1; id: string; title: string; author: string; defaultEdition: Edition;
  editions: Record<Edition, { batch: string; publishedAt: string; chapters: BookChapter[] }> };
export type BookChapter = { id: string; sequence: number; title: string; assembly: string; source: string; duration: number; checksum: string };

export async function publishBook(p: Pipeline, batch: string, edition: Edition, title: string, author: string, append = false) {
  id.parse(batch);
  editionSchema.parse(edition);
  const fictionId = (await p.store.read<{ fictionId: string }>('index.json'))?.fictionId ?? (await p.config()).fictionId;
  const delivery = await p.store.read<{ chapters: { sequence: number; assembly: string }[] }>(`deliveries/${batch}/manifest.json`);
  if (!delivery?.chapters.length) throw new Error('Batch has no completed delivery');
  const chapters: BookChapter[] = [];
  for (const item of delivery.chapters) {
    const a = await p.store.read<Assembly>(`assemblies/${item.assembly}/metadata.json`);
    if (!a || sha(await readFile(p.store.path(`assemblies/${a.id}/chapter.mp3`))) !== a.checksum) throw new Error('Delivery checksum mismatch');
    const savedPlan = await p.store.read<{ policy: { model: string }; quality?: { status: string } }>(`plans/${a.plan}.json`);
    if (savedPlan?.quality?.status === 'blocked') throw new Error('Draft assembly has unresolved major audio review issues');
    const expectedModel = Object.hasOwn(knownEditionModels, edition) ? knownEditionModels[edition] : undefined;
    if (!savedPlan?.policy.model || (expectedModel && savedPlan.policy.model !== expectedModel)) throw new Error('Edition does not match rendered model');
    const chapter = await p.store.read<{ title: string }>(`sources/${a.source}.json`);
    chapters.push({ id: a.chapterId, sequence: a.sequence, title: chapter!.title, assembly: a.id, source: a.source, duration: a.duration, checksum: a.checksum });
  }
  const book: Book = await p.store.read<Book>('book.json') ?? { schemaVersion: 1, id: fictionId, title, author, defaultEdition: edition, editions: {} };
  if (Object.keys(book.editions).length) await p.store.object('book-history', book);
  if (append) chapters.push(...(book.editions[edition]?.chapters ?? []).filter(old => !chapters.some(c => c.id === old.id)));
  chapters.sort((a, b) => a.sequence - b.sequence);
  book.title = title; book.author = author;
  book.editions[edition] = { batch, publishedAt: new Date().toISOString(), chapters };
  const revision = await p.store.object('book-history', book);
  await p.store.write('book.json', book);
  return { book: book.id, edition, chapters: chapters.length, revision };
}

// Analysis and casting finish before any speech request, allowing a complete cost preview.
export async function prepareBook(p: Pipeline, batch: string, only?: string[]) {
  id.parse(batch);
  const config = await p.config();
  const index = await p.store.read<{ chapters: { id: string; sequence: number; current: string }[] }>('index.json');
  const entries = index?.chapters.filter(c => !only || only.includes(c.id)) ?? [];
  if (!entries.length || (only && only.length !== entries.length)) throw new Error('Invalid chapter selection');
  const budget = new Budget(p.store, batch, config, await p.store.read<Ledger>(`jobs/${batch}/ledger.json`) ?? { charges: [] });
  const previews = [];
  for (const entry of entries) {
    const chapter = await p.source(entry.id), context = await p.earlierContext(chapter.sequence);
    const head = await p.store.read<{ source: string; analysis: string; dependency: string; castBefore: Cast }>(`heads/${entry.id}.json`);
    let analysis = head && await p.store.read<Analysis>(`analyses/${head.analysis}.json`);
    let cast = await p.cast();
    if (!analysis || !head || head.source !== entry.current || head.dependency !== analysisFingerprint(chapter, config, context, head.castBefore)) {
      analysis = await analyzeRemote(chapter, config, context, cast, async input => {
        await budget.reserve('analysis', 0, ((Buffer.byteLength(input) + 16000) * config.analysis.usdPerMillionInputTokens
          + config.analysis.maxOutputTokens * config.analysis.usdPerMillionOutputTokens) / 1e6, config.analysis.model, chapter.sequence);
      }, analysis, async attempt => { await p.store.object('analysis-attempts', attempt); });
      await p.commitAnalysis(chapter, entry.current, analysis, cast, config, context);
      cast = await p.cast();
    }
    const corrections = await p.store.read<Correction[]>(`corrections/${chapter.chapterId}.json`) ?? [];
    const segments = plan(chapter, analysis, cast, config, corrections);
    const characters = segments.reduce((sum, s) => sum + s.characters, 0);
    previews.push({ chapter: chapter.chapterId, sequence: chapter.sequence, source: chapter.contentHash,
      characters, requests: segments.length, estimatedSpeechUsd: characters / 1000 * config.budget.usdPerThousandCharacters,
      uncertainSpans: analysis.spans.filter(s => s.certainty !== 'attributed' || s.confidence < 0.7).map(s => s.uid),
      narrationCharacters: analysis.spans.filter(s => s.speaker === 'narrator').reduce((n, s) => n + s.text.length, 0) });
  }
  const preview = { model: config.policy.model, config: await p.store.object('configs', config), chapters: previews,
    estimatedSpeechUsd: previews.reduce((n, c) => n + c.estimatedSpeechUsd, 0) };
  await p.store.write(`previews/${batch}.json`, preview);
  return preview;
}
