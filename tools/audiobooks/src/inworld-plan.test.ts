import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentsFor, prepareChapter } from './inworld-plan.js';
import { type Chapter, type Analysis } from './schema.js';
import { sha, Store } from './store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { visualRedactionPolicy } from './spoken-redactions.js';
test('Inworld preparation preserves every source offset and keeps thoughts with the narrator', () => {
  const text = 'Mira waited. “Go!” she thought. “Stay,” she said.';
  const chapter: Chapter = { schemaVersion: 1, chapterId: 'chapter-1', fictionId: 'book-1', sequence: 1, title: 'Chapter One', url: 'https://example.org/1', retrievedAt: new Date().toISOString(), text, contentHash: sha(text) };
  const pieces = ['Mira waited. ', '“Go!” she thought. ', '“Stay,”', ' she said.'];
  let start = 0;
  const analysis: Analysis = { schemaVersion: 1, source: chapter.contentHash, fingerprint: '', model: 'fixture', promptVersion: 'test', characters: [], aliasUpdates: [], summary: '', spans: pieces.map((piece, i) => {
    const span = { uid: 'span_' + i, start, end: start + piece.length, text: piece, kind: i === 1 ? 'thought' as const : i === 2 ? 'dialogue' as const : 'prose' as const, speaker: i === 1 || i === 2 ? 'mira' : 'narrator', certainty: 'attributed' as const, confidence: 1, reason: 'Fixture' }; start = span.end; return span;
  }) };
  const segments = segmentsFor(chapter, analysis, { before: 'Before note', after: 'After note' });
  const body = segments.filter(s => !s.presentation);
  assert.equal(body.map(s => s.text).join(''), text);
  assert.equal(body.find(s => s.text.includes('thought'))?.role, 'narrator');
  assert.equal(body.find(s => s.text === '“Stay,”')?.role, 'mira');
  assert.deepEqual(segments.filter(s => s.presentation).map(s => s.role), ['narrator', 'author-note', 'author-note']);
  assert.throws(() => segmentsFor(chapter, { ...analysis, spans: analysis.spans.slice(1) }, { before: '', after: '' }), /coverage/);
});
test('a concealed recurring speaker uses anonymous speech without exposing identity or losing source evidence', () => {
  const text = '“Come closer,” said the visitor at the doorway.\n“Who are you?”';
  const pieces = ['“Come closer,”', ' said the visitor at the doorway.\n', '“Who are you?”'];
  const chapter: Chapter = { schemaVersion: 1, chapterId: 'chapter-1', fictionId: 'book-1', sequence: 1, title: 'Chapter One', url: 'https://example.org/1', retrievedAt: new Date().toISOString(), text, contentHash: sha(text) };
  let start = 0;
  const analysis: Analysis = { schemaVersion: 1, source: chapter.contentHash, fingerprint: '', model: 'fixture', promptVersion: 'test', characters: [], aliasUpdates: [], summary: '', spans: pieces.map((piece, i) => {
    const span = { uid: `span-${i}`, start, end: start + piece.length, text: piece, kind: i === 1 ? 'prose' as const : 'dialogue' as const,
      speaker: i === 0 ? 'concealed:masked_visitor' : i === 1 ? 'narrator' : 'anonymous',
      certainty: i === 0 ? 'concealed' as const : i === 1 ? 'attributed' as const : 'uncertain' as const, confidence: 1, reason: 'Source keeps identity unresolved' };
    start = span.end; return span;
  }) };
  const original = structuredClone(analysis);
  const body = segmentsFor(chapter, analysis, { before: '', after: '' }).filter(segment => !segment.presentation);
  assert.deepEqual(body.map(segment => segment.role), ['anonymous', 'narrator', 'anonymous']);
  assert.equal(body.map(segment => segment.text).join(''), text);
  assert.deepEqual(body.flatMap(segment => segment.spans), analysis.spans.map(({ start, end, uid }) => ({ start, end, uid })));
  assert.deepEqual(analysis, original);
  const attributed = structuredClone(analysis); attributed.spans[0]!.certainty = 'attributed';
  assert.throws(() => segmentsFor(chapter, attributed, { before: '', after: '' }), /Unsafe speaker ID/);
  const unsafe = structuredClone(analysis); unsafe.spans[0]!.speaker = '../unsafe';
  assert.throws(() => segmentsFor(chapter, unsafe, { before: '', after: '' }), /Unsafe speaker ID/);
});
test('ordered attribution checkpoints identity once while independent direction workers resume without shared cast writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inworld-phases-')), state = new Store(join(root, 'state')), output = new Store(join(root, 'prepared'));
  try {
    const pieces = Array.from({ length: 26 }, (_, i) => `“Line ${i} ${'word '.repeat(300)}”\n`), text = pieces.join('');
    const chapter: Chapter = { schemaVersion: 1, chapterId: 'chapter-2', fictionId: 'book-1', sequence: 2, title: 'Chapter Two', url: 'https://example.org/2', retrievedAt: new Date().toISOString(), text, contentHash: sha(text) };
    const profile = { id: 'actor', name: 'Actor', aliases: [], portrayal: 'Established female actor', importance: 'minor' as const, tags: ['female'], evidence: text, continuityFrom: null };
    let start = 0;
    const analysis: Analysis = { schemaVersion: 1, source: chapter.contentHash, fingerprint: '', model: 'fixture', promptVersion: 'test', characters: [], aliasUpdates: [], summary: 'Chapter two context', spans: pieces.map((piece, i) => {
      const span = { uid: `span-${i}`, start, end: start + piece.length, text: piece, kind: 'dialogue' as const, speaker: 'actor', certainty: 'attributed' as const, confidence: 1, reason: 'Fixture' }; start = span.end; return span;
    }) };
    await state.write('cast.json', { schemaVersion: 1, members: [{ id: 'actor', name: 'Actor', aliases: [], first: { chapter: 1, offset: 0 }, evidence: 'Earlier source', portrayal: profile.portrayal, importance: 'minor', voices: [] }] });
    await state.write('index.json', { chapters: [{ id: chapter.chapterId, current: chapter.contentHash }] });
    await state.write(`sources/${chapter.contentHash}.json`, chapter);
    await output.write('config.json', { state: state.root, directory: output.root, model: 'fixture', context: 'Previous context', chapterIds: ['missing-previous', chapter.chapterId] });
    await assert.rejects(prepareChapter(output.path('config.json'), chapter.chapterId, 'attribute'), /Previous selected chapter/);
    await output.write('config.json', { state: state.root, directory: output.root, model: 'fixture', context: 'Previous context', chapterIds: [chapter.chapterId] });
    let attributionCalls = 0;
    await prepareChapter(output.path('config.json'), chapter.chapterId, 'attribute', { analyze: async () => { attributionCalls++; return { analysis, profiles: [profile] }; }, direct: async () => { throw Error('Attribution cannot request directions'); } });
    assert.equal(attributionCalls, 1);
    assert.equal(await output.read(`plans/${chapter.chapterId}/plan.json`), undefined);
    const originalCast = await state.read('cast.json');
    let directionCalls = 0, fail = true;
    const direct: NonNullable<Parameters<typeof prepareChapter>[3]>['direct'] = async request => {
      directionCalls++;
      assert.equal(request.reasoningEffort, 'medium'); assert.equal(request.timeoutMs, 480000);
      const selected = (JSON.parse(request.input) as { segments: { uid: string }[] }).segments;
      assert.ok(selected.length <= 12);
      if (fail && directionCalls === 2) throw Error('Interrupted direction request');
      return { authentication: 'chatgpt', usage: {}, value: { directions: selected.map(segment => ({ uid: segment.uid, instruction: 'Speak with natural restraint.', rationale: 'Scene context' })) } };
    };
    await assert.rejects(prepareChapter(output.path('config.json'), chapter.chapterId, 'directions', { direct }), /Interrupted/);
    fail = false;
    await prepareChapter(output.path('config.json'), chapter.chapterId, 'directions', { direct, analyze: async () => { throw Error('Directions cannot reattribute'); } });
    assert.equal(directionCalls, 4); // The first twelve directions survive interruption.
    assert.deepEqual(await state.read('cast.json'), originalCast);
    const plan = (await output.read<{ segments: { text: string; presentation?: string }[]; directions: unknown[]; spokenRendering?: { policy: string } }>(`plans/${chapter.chapterId}/plan.json`))!;
    assert.equal(plan.segments.filter(segment => !segment.presentation).map(segment => segment.text).join(''), text);
    assert.equal(plan.directions.length, 27); // Title plus every source segment.
    assert.deepEqual(plan.spokenRendering, { policy: visualRedactionPolicy });
    const legacy = { ...plan }; delete legacy.spokenRendering;
    await output.write(`plans/${chapter.chapterId}/plan.json`, legacy);
    await prepareChapter(output.path('config.json'), chapter.chapterId, 'directions', { direct: async () => { throw Error('Ready legacy plans cannot be regenerated'); } });
    assert.deepEqual(await output.read(`plans/${chapter.chapterId}/plan.json`), legacy);
  } finally { await rm(root, { recursive: true, force: true }); }
});
