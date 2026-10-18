import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreFrontier } from './frontier-analysis.js';
import { restoreUnitResponse, unitResponseSchema, sourceUnits } from './analysis-units.js';
import { PROMPT } from './analysis.js';
import { restoreRanges } from './local-analysis.js';
import { analysisResponseSchema, restoreAnalysisResponse, type Analysis, type Chapter } from './schema.js';
import { segmentsFor } from './inworld-plan.js';
import { fingerprint, sha } from './store.js';

const label = { kind: 'prose' as const, speaker: 'narrator', certainty: 'attributed' as const, confidence: 1, reason: 'Exact source context' };
const chapterFor = (text: string): Chapter => ({ schemaVersion: 1, fictionId: 'book', chapterId: 'chapter', sequence: 1,
  title: 'One', url: 'https://example.org/chapter', retrievedAt: '2026-10-18T00:00:00.000Z', text, contentHash: sha(text) });

test('future nullable section labels preserve every source unit, narrative kind and stable legacy span shape', () => {
  const units = ['Author note: Thank you for reading!\n', 'A traveler opened the door.\n',
    'An epigraph from the old book.\n', 'System: strength five.\n', 'Author note: Next chapter tomorrow.'];
  const chapter = chapterFor(units.join('')), values = units.map((_, i) => ({ ...label,
    kind: i === 2 ? 'quotation' : i === 3 ? 'system' : 'prose', section: i === 0 || i === 4 ? 'author-note' : null }));
  const raw = { characters: [], aliasUpdates: [], summary: '', labels: Object.fromEntries(values.map((value, i) => [`unit_${i}`, value])) };
  const frontier = restoreFrontier(raw, chapter, { schemaVersion: 1, members: [] }, undefined, units).analysis;
  const restored = restoreUnitResponse(raw, units);
  assert.equal(frontier.spans.map(span => span.text).join(''), chapter.text);
  assert.deepEqual(frontier.spans.map(span => span.section), ['author-note', undefined, undefined, undefined, 'author-note']);
  assert.deepEqual(frontier.spans.map(span => span.kind), ['prose', 'prose', 'quotation', 'system', 'prose']);
  assert.deepEqual(restored.spans, values.map(({ section, ...value }, i) => ({ ...value,
    ...(section === 'author-note' ? { section } : {}), text: units[i] })));
  for (const span of frontier.spans) assert.equal(chapter.text.slice(span.start, span.end), span.text);
  assert.ok(!Object.hasOwn(frontier.spans[1]!, 'section'));
  assert.match(PROMPT, /Never tag epigraphs, quoted in-world articles, system messages, character statistics/);
});

test('strict model schemas require nullable section while legacy cached labels remain accepted without mutation', () => {
  const schema = unitResponseSchema(1, true, ['Text.']) as { properties: { labels: { properties: { unit_0: { required: string[]; properties: { parts: { anyOf: { items?: { required: string[] } }[] } } } } } } };
  const wire = schema.properties.labels.properties.unit_0;
  assert.ok(wire.required.includes('section'));
  assert.ok(wire.properties.parts.anyOf.find(value => value.items)?.items?.required.includes('section'));
  assert.throws(() => analysisResponseSchema.parse({ characters: [], aliasUpdates: [], summary: '', spans: [{ ...label, text: 'Text.' }] }));
  const raw = { characters: [], aliasUpdates: [], summary: '', labels: { unit_0: label } }, before = fingerprint(raw);
  const legacy = restoreUnitResponse(raw, ['Text.']);
  assert.ok(!Object.hasOwn(legacy.spans[0]!, 'section')); assert.equal(fingerprint(raw), before);
  const direct = restoreAnalysisResponse({ ...legacy, spans: [{ ...legacy.spans[0], section: null }] });
  assert.deepEqual(direct, legacy);
  assert.throws(() => restoreAnalysisResponse({ ...legacy, spans: [{ ...legacy.spans[0], section: 'system' }] }));
});

test('same-voice note/body boundaries stay distinct without changing source offsets, UID claims or input analyses', () => {
  const units = ['Author note: Thanks!\n', 'The story begins.\n', 'Author note: See you soon.'], chapter = chapterFor(units.join(''));
  const result = restoreFrontier({ characters: [], aliasUpdates: [], summary: '', labels: Object.fromEntries(units.map((_, i) => [`unit_${i}`, { ...label,
    section: i === 1 ? null : 'author-note' }])) }, chapter, { schemaVersion: 1, members: [] }, undefined, units);
  const analysis: Analysis = result.analysis, before = fingerprint({ chapter, analysis });
  const body = segmentsFor(chapter, analysis, { before: 'Boxed before', after: 'Boxed after' }).filter(segment => !segment.presentation);
  assert.equal(body.length, 3); assert.deepEqual(body.map(segment => segment.sectionKind), ['author-note', undefined, 'author-note']);
  assert.ok(body.every(segment => segment.role === 'narrator'));
  assert.equal(body.map(segment => segment.text).join(''), chapter.text);
  assert.deepEqual(body.flatMap(segment => segment.spans), analysis.spans.map(({ start, end, uid }) => ({ start, end, uid })));
  assert.equal(fingerprint({ chapter, analysis }), before);
});

test('a mixed semantic unit retains separate source-backed note and story labels at exact Unicode boundaries', () => {
  const story = '😀 The traveler rested. ', note = 'Author note: Thanks for reading!', text = story + note, chapter = chapterFor(text);
  const result = restoreFrontier({ characters: [], aliasUpdates: [], summary: '', labels: { unit_0: { ...label,
    section: 'author-note', parts: [{ ...label, section: null, end: story.length }, { ...label, section: 'author-note', end: text.length }],
  } } }, chapter, { schemaVersion: 1, members: [] }, undefined, [text]);
  const body = segmentsFor(chapter, result.analysis, { before: '', after: '' }).filter(segment => !segment.presentation);
  assert.deepEqual(body.map(segment => segment.sectionKind), [undefined, 'author-note']);
  assert.deepEqual(result.analysis.spans.map(span => [span.start, span.end]), [[0, story.length], [story.length, text.length]]);
  assert.equal(result.analysis.spans.map(span => span.text).join(''), text);
  assert.equal(body.map(segment => segment.text).join(''), text);
});

test('local range analysis accepts new nullable labels and restores legacy ranges without extra stored fields', () => {
  const units = ['The traveler rested.\n', 'Author note: Thanks!'];
  const common = { characters: [], aliasUpdates: [], summary: '' };
  const result = restoreRanges({ ...common, ranges: [{ ...label, section: null, first: 0, last: 0 },
    { ...label, section: 'author-note', first: 1, last: 1 }] }, units);
  assert.equal(result.spans.map(span => span.text).join(''), units.join(''));
  assert.deepEqual(result.spans.map(span => span.section), [undefined, 'author-note']);
  const legacy = restoreRanges({ ...common, ranges: [{ ...label, first: 0, last: 1 }] }, units);
  assert.ok(legacy.spans.every(span => !Object.hasOwn(span, 'section')));
});

test('remote unit and local range paths exactly separate same-paragraph story and author commentary', () => {
  const story = '😀 The traveler opened the door. ', note = 'Author note: Thanks for reading!', text = story + note;
  const units = sourceUnits(text), common = { characters: [], aliasUpdates: [], summary: '' };
  assert.deepEqual(units, [text]);
  const parts = [{ ...label, section: null, end: story.length }, { ...label, section: 'author-note', end: text.length }];
  const remote = restoreUnitResponse({ ...common, labels: { unit_0: { ...label, section: null, parts } } }, units);
  const local = restoreRanges({ ...common, ranges: [{ ...label, first: 0, last: 0, section: null, parts }] }, units);
  for (const result of [remote, local]) {
    assert.deepEqual(result.spans.map(span => span.text), [story, note]);
    assert.deepEqual(result.spans.map(span => span.section), [undefined, 'author-note']);
    const chapter = chapterFor(text), analysis = restoreFrontier({ ...common,
      labels: { unit_0: { ...label, section: null, parts } } }, chapter, { schemaVersion: 1, members: [] }, undefined, units).analysis;
    assert.equal(result.spans.map(span => span.text).join(''), chapter.text);
    assert.deepEqual(analysis.spans.map(span => [span.start, span.end]), [[0, story.length], [story.length, text.length]]);
  }
  // A model that cannot separate the mixed unit must never hide the story.
  const unsplitRemote = restoreUnitResponse({ ...common, labels: { unit_0: { ...label, section: 'author-note', parts: null } } }, units);
  const unsplitLocal = restoreRanges({ ...common, ranges: [{ ...label, first: 0, last: 0, section: 'author-note', parts: null }] }, units);
  assert.ok([unsplitRemote, unsplitLocal].every(result => result.spans.length === 1 && result.spans[0]!.section === undefined));
});

test('mixed-unit parts reject gaps, nonmonotonic ends, word/surrogate cuts and unsupported multi-unit ranges', () => {
  const text = '😀 Story prose. Author note: Thanks!', common = { characters: [], aliasUpdates: [], summary: '' };
  for (const ends of [[1, text.length], [5, text.length], [text.length - 1], [text.length, text.length]]) {
    const parts = ends.map(end => ({ ...label, section: null, end }));
    assert.throws(() => restoreUnitResponse({ ...common, labels: { unit_0: { ...label, parts } } }, [text]), /semantic|cover source/i);
    assert.throws(() => restoreRanges({ ...common, ranges: [{ ...label, first: 0, last: 0, parts }] }, [text]), /semantic|cover source/i);
  }
  assert.throws(() => restoreRanges({ ...common, ranges: [{ ...label, first: 0, last: 1,
    parts: [{ ...label, end: 5 }] }] }, ['First.', 'Second.']), /single-unit range/);
  const legacy = { ...common, ranges: [{ ...label, first: 0, last: 0 }] }, before = fingerprint(legacy);
  assert.deepEqual(restoreRanges(legacy, [text]).spans.map(span => span.text), [text]);
  assert.equal(fingerprint(legacy), before);
});
