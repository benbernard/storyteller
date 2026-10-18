import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentsFor } from './inworld-plan.js';
import { type Chapter, type Analysis } from './schema.js';
import { sha } from './store.js';
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
