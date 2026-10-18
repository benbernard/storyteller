import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chapterSchema, configSchema, correctionSchema, comparePosition, type Analysis, type Assembly,
  type Asset, type Cast, type Chapter, type Config, type Correction, type Position, type Segment,
  type RawAnalysis, type Voice } from './schema.js';
import { analyzeRemote, analysisFingerprint, importedAnalysis, resolveCast } from './analysis.js';
import { Budget, concatenate, type Ledger, type Renderer, renderSegment, cachedAsset } from './audio.js';
import { plan } from './planner.js';
import { Store, fingerprint, sha, commitDirectory } from './store.js';

type Index = { schemaVersion: 1; fictionId: string; chapters: { id: string; sequence: number; revisions: string[]; current: string }[] };
type Head = { source: string; analysis: string; castBefore: Cast; context: string; dependency: string };
type Job = { schemaVersion: 1; id: string; config: string; sources: string[]; purpose: 'pilot' | 'batch' | 'repair';
  edits: string;
  status: 'running' | 'failed' | 'complete'; chapters: { chapterId: string; sequence: number;
    status: 'pending' | 'analyzing' | 'rendering' | 'complete' | 'failed'; assembly?: string; error?: string }[] };
type Review = { id: string; chapter: number; spanId: string; severity: 'notice' | 'consequential';
  assembly: string; segment: string; start: number; end: number; audio: string;
  reason: string; status: 'open' | 'resolved' };

export class Pipeline {
  constructor(readonly store: Store) {}
  async configure(input: unknown) {
    const config = configSchema.parse(input);
    const index = await this.store.read<Index>('index.json');
    if (index && index.fictionId !== config.fictionId) throw new Error('State belongs to a different fiction');
    for (const voice of config.pool) {
      if (!await cachedAsset(this.store, voice.sampleAsset)) throw new Error('Voice pool entry must reference a saved audition asset');
    }
    // Config history is immutable, and contains no credentials.
    const key = await this.store.object('configs', config);
    await this.store.write('config.json', { key });
    return key;
  }
  async config(): Promise<Config> {
    const ref = await this.store.read<{ key: string }>('config.json');
    if (!ref) throw new Error('Configure this fiction first');
    return configSchema.parse(await this.store.read(`configs/${ref.key}.json`));
  }
  async cast(): Promise<Cast> { return await this.store.read<Cast>('cast.json') ?? { schemaVersion: 1, members: [] }; }
  async saveCast(cast: Cast) {
    await this.store.object('cast-history', cast);
    await this.store.write('cast.json', cast);
  }
  async ingest(input: unknown) {
    const chapter = chapterSchema.parse(input), config = await this.config();
    if (chapter.fictionId !== config.fictionId) throw new Error('Fiction ID mismatch');
    if (sha(chapter.text) !== chapter.contentHash) throw new Error('Content hash does not match exact UTF-8 text');
    const index = await this.store.read<Index>('index.json') ?? { schemaVersion: 1, fictionId: config.fictionId, chapters: [] };
    if (index.chapters.some(c => c.sequence === chapter.sequence && c.id !== chapter.chapterId)) throw new Error('Duplicate chapter sequence');
    let entry = index.chapters.find(c => c.id === chapter.chapterId);
    if (entry && entry.sequence !== chapter.sequence) throw new Error('Chapter ordering changed; migrate explicitly');
    if (entry) {
      const existing = await this.store.read<Chapter>(`sources/${entry.current}.json`);
      if (existing && fingerprint({ ...existing, retrievedAt: '' }) === fingerprint({ ...chapter, retrievedAt: '' })) return entry.current;
    }
    const key = await this.store.object('sources', chapter);
    if (!entry) { entry = { id: chapter.chapterId, sequence: chapter.sequence, revisions: [], current: key }; index.chapters.push(entry); }
    if (!entry.revisions.includes(key)) entry.revisions.push(key);
    entry.current = key;
    index.chapters.sort((a, b) => a.sequence - b.sequence);
    await this.store.write('index.json', index);
    return key;
  }
  async source(chapterId: string): Promise<Chapter> {
    const index = await this.store.read<Index>('index.json');
    const entry = index?.chapters.find(c => c.id === chapterId);
    const chapter = entry && await this.store.read<Chapter>(`sources/${entry.current}.json`);
    if (!chapter) throw new Error('Chapter not found');
    return chapter;
  }
  async earlierContext(sequence: number): Promise<string> {
    const index = await this.store.read<Index>('index.json');
    const earlier = index?.chapters.filter(c => c.sequence < sequence) ?? [];
    const summaries: { chapter: number; summary: string; source: string }[] = [];
    for (const entry of earlier) {
      const head = await this.store.read<Head>(`heads/${entry.id}.json`);
      if (!head || head.source !== entry.current) throw new Error('Analyze earlier source revisions in sequence first');
      const expectedContext = JSON.stringify({ previous: summaries.at(-1)?.summary ?? '', history: fingerprint(summaries) });
      if (head.context !== expectedContext) throw new Error('Earlier story context changed; process affected chapters in sequence first');
      const analysis = await this.store.read<Analysis>(`analyses/${head.analysis}.json`);
      if (!analysis) throw new Error('Earlier analysis is missing');
      summaries.push({ chapter: entry.sequence, summary: analysis.summary, source: entry.current });
    }
    // Every prior chapter contributes; no future chapter or future alias enters the prompt.
    return JSON.stringify({ previous: summaries.at(-1)?.summary ?? '', history: fingerprint(summaries) });
  }
  async importAnalysis(chapterId: string, raw: RawAnalysis) {
    const chapter = await this.source(chapterId), config = await this.config();
    const cast = await this.cast(), context = await this.earlierContext(chapter.sequence);
    const previousHead = await this.store.read<Head>(`heads/${chapterId}.json`);
    const previous = previousHead && await this.store.read<Analysis>(`analyses/${previousHead.analysis}.json`);
    const analysis = importedAnalysis(raw, chapter, cast, previous);
    const index = (await this.store.read<Index>('index.json'))!;
    const source = index.chapters.find(c => c.id === chapterId)!.current;
    return this.commitAnalysis(chapter, source, analysis, cast, config, context);
  }
  async commitAnalysis(chapter: Chapter, source: string, analysis: Analysis, cast: Cast, config: Config, context: string) {
    const nextCast = resolveCast(cast, analysis, chapter, config);
    for (const member of nextCast.members) {
      for (const version of member.voices) {
        if (version.from.chapter !== chapter.sequence || !version.fromSpanId) continue;
        const anchor = analysis.spans.find(s => s.uid === version.fromSpanId);
        if (anchor) version.from.offset = anchor.start;
      }
      if (member.first.chapter === chapter.sequence && member.voices[0]) member.first = { ...member.voices[0].from };
    }
    // Save the cast before any dependent render. Replaying after a crash preserves choices.
    await this.saveCast(nextCast);
    const key = await this.store.object('analyses', analysis);
    await this.store.write(`heads/${chapter.chapterId}.json`, { source, analysis: key, castBefore: cast, context,
      dependency: analysisFingerprint(chapter, config, context, cast) } satisfies Head);
    return key;
  }
  async run(batchId: string, renderer: Renderer, purpose: Job['purpose'] = 'batch', only?: string[],
    override?: Config, budgetId = batchId) {
    const config = override ?? await this.config(), configKey = await this.store.object('configs', config);
    if (purpose === 'batch' && !config.policy.selectedAfterListening) throw new Error('Run and rate the pilot before selecting a production policy');
    const index = await this.store.read<Index>('index.json');
    const entries = index?.chapters.filter(c => !only || only.includes(c.id)) ?? [];
    if (!entries.length || (only && entries.length !== only.length)) throw new Error('No chapters or invalid chapter selection');
    let job = await this.store.read<Job>(`jobs/${batchId}/job.json`);
    const sources = entries.map(e => e.current);
    const castAtStart = await this.cast();
    const edits = fingerprint({ voices: castAtStart.members.flatMap(m => m.voices.filter(v => v.provenance === 'explicit-owner-correction')),
      corrections: await Promise.all(entries.map(e => this.store.read(`corrections/${e.id}.json`))) });
    if (job && (job.config !== configKey || fingerprint(job.sources) !== fingerprint(sources) || job.purpose !== purpose || job.edits !== edits))
      throw new Error('Batch inputs changed; use a new batch ID. Earlier assets remain reusable.');
    if (job?.status === 'complete') {
      for (const item of job.chapters) {
        const assembly = await this.store.read<Assembly>(`assemblies/${item.assembly}/metadata.json`);
        if (!assembly || sha(await readFile(this.store.path(`assemblies/${item.assembly}/chapter.mp3`))) !== assembly.checksum)
          throw new Error('Completed delivery checksum mismatch');
      }
      return { batch: batchId, status: 'complete', reused: true };
    }
    job ??= { schemaVersion: 1, id: batchId, config: configKey, sources, purpose, edits, status: 'running',
      chapters: entries.map(e => ({ chapterId: e.id, sequence: e.sequence, status: 'pending' })) };
    const budget = new Budget(this.store, budgetId, config, await this.store.read<Ledger>(`jobs/${budgetId}/ledger.json`) ?? { charges: [] });
    const save = () => this.store.write(`jobs/${batchId}/job.json`, job);
    job.status = 'running'; await save();
    try {
      for (const [i, entry] of entries.entries()) {
        const chapterStatus = job.chapters[i]!;
        try {
          const chapter = (await this.store.read<Chapter>(`sources/${entry.current}.json`))!;
          chapterStatus.status = 'analyzing'; delete chapterStatus.error; await save();
          const context = await this.earlierContext(chapter.sequence);
          const head = await this.store.read<Head>(`heads/${entry.id}.json`);
          let analysis = head && await this.store.read<Analysis>(`analyses/${head.analysis}.json`);
          let cast = await this.cast();
          const dependency = analysisFingerprint(chapter, config, context, head?.castBefore ?? cast);
          if (!head || head.source !== entry.current || head.dependency !== dependency || !analysis) {
            const previous = analysis;
            analysis = await analyzeRemote(chapter, config, context, cast, async input => {
              // UTF-8 bytes are a conservative input-token upper bound; include instructions/schema overhead.
              const upperInput = Buffer.byteLength(input) + 16_000;
              await budget.reserve('analysis', 0, (upperInput * config.analysis.usdPerMillionInputTokens
                + config.analysis.maxOutputTokens * config.analysis.usdPerMillionOutputTokens) / 1e6,
              config.analysis.model, chapter.sequence);
            }, previous, async attempt => { await this.store.object('analysis-attempts', attempt); });
            await this.commitAnalysis(chapter, entry.current, analysis, cast, config, context);
            cast = await this.cast();
          }
          const analysisKey = fingerprint(analysis);
          const corrections = await this.store.read<Correction[]>(`corrections/${entry.id}.json`) ?? [];
          const segments = plan(chapter, analysis, cast, config, corrections);
          const planKey = await this.store.object('plans', { source: entry.current, analysis: analysisKey, segments, policy: config.policy });
          chapterStatus.status = 'rendering'; await save();
          const assets: Asset[] = [];
          // One active paid request bounds provider concurrency and makes request stitching deterministic.
          for (const segment of segments) assets.push(await renderSegment(this.store, segment, config, budget,
            renderer, chapter.sequence, segment.previousSegment ? assets.at(-1) : undefined, purpose === 'repair' ? 'rerender' : 'render'));
          const assembly = await this.assemble(chapter, entry.current, analysisKey, planKey, segments, assets, config);
          await this.queueReviews(analysis, chapter, cast, assembly);
          chapterStatus.assembly = assembly.id; chapterStatus.status = 'complete'; await save();
        } catch (error) {
          chapterStatus.status = 'failed'; chapterStatus.error = safeError(error); await save(); throw error;
        }
      }
      // One atomic manifest is the delivery commit point; failed batches have no delivery.
      const delivery = { schemaVersion: 1, batch: batchId, fictionId: config.fictionId, purpose,
        chapters: job.chapters.map(c => ({ sequence: c.sequence, assembly: c.assembly,
          audio: `../../assemblies/${c.assembly}/chapter.mp3` })) };
      await this.store.write(`deliveries/${batchId}/manifest.json`, delivery);
      job.status = 'complete'; await save();
      return { batch: batchId, status: 'complete', chapters: job.chapters.length,
        delivery: `deliveries/${batchId}/manifest.json` };
    } catch (error) { job.status = 'failed'; await save(); throw error; }
  }
  async experiments(batchId: string, renderer: Renderer, only?: string[]) {
    const config = await this.config();
    if (config.policy.model.startsWith('inworld-')) throw new Error('Experiments compare ElevenLabs models; audition Inworld models separately');
    const variants = [
      { name: 'v3-scenes', model: 'eleven_v3', grouping: 'scene', maxCharacters: 1800, continuity: 'none' },
      { name: 'v3-turns', model: 'eleven_v3', grouping: 'turn', maxCharacters: 600, continuity: 'none' },
      { name: 'v2-passages', model: 'eleven_multilingual_v2', grouping: 'scene', maxCharacters: 1200, continuity: 'none' },
      { name: 'v2-long-stitched', model: 'eleven_multilingual_v2', grouping: 'scene', maxCharacters: 3500, continuity: 'requests' },
    ] as const;
    const results = [];
    for (const variant of variants) {
      const { name, ...policy } = variant;
      const trial = configSchema.parse({ ...config, policy: { ...config.policy, ...policy,
        version: name, selectedAfterListening: false, listeningEvidence: '' } });
      results.push(await this.run(`${batchId}-${name}`, renderer, 'pilot', only, trial, batchId));
    }
    await this.store.write(`experiments/${batchId}.json`, { schemaVersion: 1, results,
      listeningCriteria: ['narrator consistency', 'character distinction', 'pacing', 'joined boundaries',
        'omissions and repeats', 'performance', 'repair scope', 'characters including retries'] });
    return { results, sharedBudget: batchId, next: 'Listen to joined chapter audio, then record the selected policy and listening evidence' };
  }
  async assemble(chapter: Chapter, source: string, analysis: string, planKey: string, segments: Segment[], assets: Asset[], config: Config) {
    const key = fingerprint({ source, analysis, plan: planKey, assets: assets.map(a => a.checksum), pause: config.policy.joinPauseMs, assembler: 1 });
    const cached = await this.store.read<Assembly>(`assemblies/${key}/metadata.json`);
    if (cached) {
      if (sha(await readFile(this.store.path(`assemblies/${key}/chapter.mp3`))) !== cached.checksum) throw new Error('Assembly checksum mismatch');
      return cached;
    }
    const temporary = `assemblies/.pending-${randomUUID()}`;
    await mkdir(this.store.path(temporary), { recursive: true, mode: 0o700 });
    try {
      const audio = await concatenate(this.store, assets.map(a => a.fingerprint), config.policy.joinPauseMs,
        this.store.path(`${temporary}/chapter.mp3`));
      let time = 0;
      const timeline = segments.map((s, i) => {
        const start = time, end = start + audio.parts[i]!.duration;
        time = end + (i < segments.length - 1 ? audio.pause : 0);
        return { segmentId: s.uid, asset: assets[i]!.fingerprint, start, end,
          spans: s.turns.map(t => ({ uid: t.spanId, start: t.start, end: t.end })),
          ...(s.sectionKind === 'author-note' ? { sectionKind: s.sectionKind } : {}) };
      });
      const assembly: Assembly = { schemaVersion: 1, id: key, chapterId: chapter.chapterId, sequence: chapter.sequence,
        source, analysis, plan: planKey, checksum: audio.checksum, duration: audio.duration, timeline };
      await this.store.write(`${temporary}/metadata.json`, assembly);
      await commitDirectory(this.store.path(temporary), this.store.path(`assemblies/${key}`));
      return assembly;
    } catch (e) { await rm(this.store.path(temporary), { recursive: true, force: true }); throw e; }
  }
  async queueReviews(analysis: Analysis, chapter: Chapter, cast: Cast, assembly: Assembly) {
    const reviews = await this.store.read<Review[]>('reviews.json') ?? [];
    for (const span of analysis.spans) {
      const member = cast.members.find(c => c.id === span.speaker);
      const reused = member?.voices[0]?.reason.includes('reused=true');
      if (span.certainty === 'attributed' && span.confidence >= 0.7 && !reused) continue;
      const key = fingerprint({ chapter: chapter.chapterId, span: span.uid });
      const segment = assembly.timeline.find(t => t.spans.some(s => s.uid === span.uid))!;
      if (!reviews.some(r => r.id === key)) reviews.push({ id: key, chapter: chapter.sequence,
        assembly: assembly.id, segment: segment.segmentId, start: segment.start, end: segment.end,
        audio: `assets/${segment.asset}/audio.mp3`,
        spanId: span.uid, severity: span.confidence < 0.5 || reused ? 'consequential' : 'notice',
        reason: reused ? 'A voice was reused from the available pool' : span.reason, status: 'open' });
    }
    await this.store.write('reviews.json', reviews);
  }
  async progress(position: Position) {
    const old = await this.store.read<Position>('progress.json') ?? { chapter: 0, offset: 0 };
    if (comparePosition(position, old) < 0) throw new Error('Listening progress cannot move backward');
    await this.store.write('progress.json', position);
  }
  async reviews() {
    const progress = await this.store.read<Position>('progress.json') ?? { chapter: 0, offset: 0 };
    const reviews = await this.store.read<Review[]>('reviews.json') ?? [];
    const visible = reviews.filter(r => r.chapter <= progress.chapter && r.status === 'open' && r.severity === 'consequential');
    // No hidden names, reasons, chapter numbers, or media URLs leave this boundary.
    return { sealedCount: reviews.filter(r => r.chapter > progress.chapter && r.status === 'open').length,
      items: visible.slice(0, 5).map(r => ({ ...r, label: 'Listening follow-up' })) };
  }
  async locate(assemblyId: string, seconds: number) {
    const assembly = await this.store.read<Assembly>(`assemblies/${assemblyId}/metadata.json`);
    if (!assembly || !Number.isFinite(seconds) || seconds < 0 || seconds >= assembly.duration) throw new Error('Playback position is outside this delivery');
    const segment = assembly.timeline.find(t => seconds >= t.start && seconds < t.end)
      ?? assembly.timeline.find(t => t.start > seconds)!;
    // Explicitly opening a heard issue reveals only the requested segment.
    const analysis = (await this.store.read<Analysis>(`analyses/${assembly.analysis}.json`))!;
    return { assembly: assemblyId, chapter: assembly.sequence, ...segment,
      text: analysis.spans.filter(s => segment.spans.some(t => t.uid === s.uid)).map(s => ({ id: s.uid, text: s.text, speaker: s.speaker })),
      precision: 'segment' };
  }
  async correct(assemblyId: string, correction: unknown) {
    const edit = correctionSchema.parse(correction);
    const assembly = await this.store.read<Assembly>(`assemblies/${assemblyId}/metadata.json`);
    if (!assembly || !assembly.timeline.some(t => t.spans.some(s => s.uid === edit.spanId))) throw new Error('Span is not in this delivery');
    const current = await this.store.read<Head>(`heads/${assembly.chapterId}.json`);
    const currentAnalysis = current && await this.store.read<Analysis>(`analyses/${current.analysis}.json`);
    if (!currentAnalysis?.spans.some(s => s.uid === edit.spanId)) throw new Error('Source changed; locate the replacement span first');
    const path = `corrections/${assembly.chapterId}.json`;
    const edits = await this.store.read<Correction[]>(path) ?? [];
    const previous = edits.find(e => e.spanId === edit.spanId);
    // A bare rerender gets a new take while retaining any earlier attribution/pronunciation fix.
    const next = { ...previous, ...edit, take: Math.max(edit.take, (previous?.take ?? 0) + 1) };
    await this.store.object('correction-history', { assemblyId, edit: next });
    await this.store.write(path, [...edits.filter(e => e.spanId !== edit.spanId), next]);
    return { chapterId: assembly.chapterId, spanId: edit.spanId, next: 'Run repair with a fresh batch ID' };
  }
  async changeVoice(characterId: string, voice: Voice, from: Position, reason: string) {
    const cast = await this.cast(), member = cast.members.find(c => c.id === characterId);
    if (!member) throw new Error('Unknown character');
    if (comparePosition(from, member.first) < 0) throw new Error('Voice cannot start before first appearance');
    const index = await this.store.read<Index>('index.json');
    const chapter = index?.chapters.find(c => c.sequence === from.chapter);
    const head = chapter && await this.store.read<Head>(`heads/${chapter.id}.json`);
    const analysis = head && await this.store.read<Analysis>(`analyses/${head.analysis}.json`);
    const anchor = analysis?.spans.find(s => s.start === from.offset);
    if (!anchor) throw new Error('Voice changes must begin at an analyzed span boundary');
    const version = `voice_${randomUUID()}`;
    member.voices = [...member.voices.filter(v => comparePosition(v.from, from) !== 0),
      { ...voice, version, from, fromSpanId: anchor.uid, reason, provenance: 'explicit-owner-correction' }];
    await this.saveCast(cast);
    return { version, affectedFrom: from };
  }
  async status() {
    const index = await this.store.read<Index>('index.json');
    return { fictionId: index?.fictionId, chapters: index?.chapters.length ?? 0,
      ...(await this.reviews()) };
  }
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Batch failed';
  return message.replace(/(?:sk-|xi_)[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 300);
}
