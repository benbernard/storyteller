import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, sha } from './store.js';
import { renderVisualRedactions, verifyVisualRedactions, visualRedactionPolicy } from './spoken-redactions.js';
import { segmentsFor } from './inworld-plan.js';
import type { Analysis, Chapter } from './schema.js';

test('visual full-block redactions become one audible placeholder each while source coordinates stay exact', () => {
  const source = `Record: ${'█'.repeat(19)}.\nRecipient: ${'█'.repeat(12)}.\nAccess ${'█'.repeat(6)} denied.`;
  const result = renderVisualRedactions(source);
  assert.equal(result.policy, visualRedactionPolicy);
  assert.equal(result.text, 'Record: redacted.\nRecipient: redacted.\nAccess redacted denied.');
  assert.equal(result.sourceHash, sha(source)); assert.equal(result.spokenHash, sha(result.text));
  assert.deepEqual(result.mapping.filter(range => range.kind === 'redaction').map(range => range.sourceEnd - range.sourceStart), [19, 12, 6]);
  assert.equal(result.mapping.map(range => source.slice(range.sourceStart, range.sourceEnd)).join(''), source);
  assert.equal(result.mapping.map(range => result.text.slice(range.spokenStart, range.spokenEnd)).join(''), result.text);
  for (const [i, range] of result.mapping.entries()) {
    assert.equal(range.sourceStart, result.mapping[i - 1]?.sourceEnd ?? 0);
    assert.equal(range.spokenStart, result.mapping[i - 1]?.spokenEnd ?? 0);
    if (range.kind === 'copy') assert.equal(source.slice(range.sourceStart, range.sourceEnd), result.text.slice(range.spokenStart, range.spokenEnd));
  }
  assert.deepEqual(renderVisualRedactions(source), result);
  assert.deepEqual(verifyVisualRedactions(source, result), result);
});
test('redaction policy preserves non-redaction symbols and separates concealed word fragments without guessing them', () => {
  assert.equal(renderVisualRedactions('A█B ░▒▓ ■■■ [...] [REDACTED] **Name**').text, 'A█B ░▒▓ ■■■ [...] [REDACTED] **Name**');
  assert.equal(renderVisualRedactions('prefix██suffix 12██34').text, 'prefix redacted suffix 12 redacted 34');
  assert.equal(renderVisualRedactions('𐐀██𐐁! “██”, (██).').text, '𐐀 redacted 𐐁! “redacted”, (redacted).');
  assert.equal(renderVisualRedactions('██\n██').text, 'redacted\nredacted');
  assert.equal(renderVisualRedactions('').text, '');
  assert.deepEqual(renderVisualRedactions('').mapping, []);
});
test('renderer proofs reject changed words, omitted redactions, shifted ranges, and a different source', () => {
  const source = 'Before ███ after.', original = renderVisualRedactions(source);
  const changed = structuredClone(original); changed.text = 'Before a secret name after.';
  // Even a consistent attacker-controlled checksum/fingerprint cannot change
  // the renderer's deterministic literal replacement or the source coverage.
  changed.spokenHash = sha(changed.text);
  const { fingerprint: _fingerprint, ...content } = changed; changed.fingerprint = fingerprint(content);
  assert.throws(() => verifyVisualRedactions(source, changed), /exact source and policy/);
  const shifted = structuredClone(original); shifted.mapping[1]!.sourceStart++;
  assert.throws(() => verifyVisualRedactions(source, shifted), /exact source and policy/);
  const missing = structuredClone(original); missing.mapping.splice(1, 1);
  assert.throws(() => verifyVisualRedactions(source, missing), /exact source and policy/);
  assert.throws(() => verifyVisualRedactions(source + '!', original), /exact source and policy/);
});
test('the spoken view leaves canonical chapter text, analysis spans and queued segment identities intact', () => {
  const text = 'The file named ██████ remained sealed.';
  const chapter: Chapter = { schemaVersion: 1, chapterId: 'chapter-1', fictionId: 'book-1', sequence: 1, title: 'Chapter One', url: 'https://example.org/1', retrievedAt: new Date().toISOString(), text, contentHash: sha(text) };
  const analysis: Analysis = { schemaVersion: 1, source: chapter.contentHash, fingerprint: 'unchanged', promptVersion: 'test', model: 'fixture', characters: [], aliasUpdates: [], summary: 'Identity remains concealed.', spans: [
    { uid: 'original-span', start: 0, end: text.length, text, kind: 'prose', speaker: 'narrator', certainty: 'attributed', confidence: 1, reason: 'Source narration' },
  ] };
  const segments = segmentsFor(chapter, analysis, { before: '', after: '' }), original = fingerprint({ chapter, analysis, segments });
  const spoken = segments.map(segment => renderVisualRedactions(segment.text));
  assert.equal(spoken[1]!.text, 'The file named redacted remained sealed.');
  assert.equal(fingerprint({ chapter, analysis, segments }), original);
  assert.equal(segments[1]!.spans[0]!.uid, 'original-span');
  assert.equal(segments[1]!.text, text); assert.equal(analysis.source, sha(text));
});
