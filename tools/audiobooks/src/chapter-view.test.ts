import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { authorNoteRanges } from './reading.js';

type View = { duration: number; position(source: number): number; source(position: number): number; undoPosition(source: number, passages?: { start: number; end: number; sectionKind?: string }[]): number };
const ChapterView = runInNewContext(await readFile(new URL('../listener-web/chapter-view.js', import.meta.url), 'utf8') + '; ChapterView;') as new (duration: number, ranges?: { start: number; end: number }[]) => View;

test('a note-free clock seeks to the same source words and has no note slots', () => {
  const view = new ChapterView(120, [{ start: 10, end: 30 }, { start: 90, end: 120 }]);
  assert.equal(view.duration, 70);
  for (const [source, presented] of [[0, 0], [9, 9], [20, 10], [30, 10], [50, 30], [110, 70]]) assert.equal(view.position(source!), presented);
  assert.equal(view.source(10), 30); assert.equal(view.source(30), 50); assert.equal(view.source(70), 120);
  for (const source of [0, 9, 30, 50, 89]) assert.equal(view.source(view.position(source)), source);
  assert.equal(new ChapterView(120).position(50), 50);
  assert.equal(new ChapterView(120).duration, 120);
});
test('invalid note metadata never subtracts story time', () => {
  const view = new ChapterView(10, [{ start: -1, end: 2 }, { start: 0, end: 12 }, { start: 5, end: 4 }, { start: NaN, end: 7 }, { start: 10.05, end: 10.1 }]);
  assert.equal(view.duration, 10);
  assert.equal(new ChapterView(10, [{ start: 0, end: 10 }]).source(0), 10);
});
test('old Undo targets in notes resolve to the preceding included passage', () => {
  const view = new ChapterView(10, [{ start: 2, end: 4 }, { start: 8, end: 10 }]);
  const passages = [{ start: 0, end: 2 }, { start: 2, end: 4, sectionKind: 'author-note' }, { start: 4, end: 8 }, { start: 8, end: 10, sectionKind: 'author-note' }];
  assert.equal(view.undoPosition(3, passages), 0); assert.equal(view.undoPosition(9, passages), 4); assert.equal(view.undoPosition(6, passages), 6);
});
test('range metadata includes only positive tags and their short trailing joins', () => {
  assert.deepEqual(authorNoteRanges({ duration: 10, passages: [
    { id: 'title', start: 0, end: 1, text: 'Announcement' },
    { id: 'note', start: 1.1, end: 3, text: 'Note', sectionKind: 'author-note' as const },
    { id: 'body', start: 3.1, end: 7, text: 'Body' },
    { id: 'end', start: 7.1, end: 9.9, text: 'Note', sectionKind: 'author-note' as const },
  ].map(p => ({ ...p, startOffset: 0, endOffset: 0, speakers: [], spans: [] })) }), [{ start: 1.1, end: 3.1 }, { start: 7.1, end: 10 }]);
});
