import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint } from './store.js';
import { renderSpokenDisplay, spokenDisplayPolicy, verifySpokenDisplay } from './spoken-display.js';
import { renderVisualRedactions } from './spoken-redactions.js';

test('combined display rendering pins both exact policies and complete linked UTF16 maps', () => {
  const source = '😀 S\u0334e\u0337aled: ██ E+.', result = renderSpokenDisplay(source);
  assert.equal(result.policy, spokenDisplayPolicy); assert.equal(result.text, '😀 Sealed: redacted E+.');
  assert.equal(result.sourceHash, result.stages[0].sourceHash);
  assert.equal(result.stages[0].spokenHash, result.stages[1].sourceHash);
  assert.equal(result.spokenHash, result.stages[1].spokenHash);
  assert.deepEqual(verifySpokenDisplay(source, result), result);
  assert.deepEqual(result.stages[1], renderVisualRedactions(result.stages[0].text));
  assert.equal(renderSpokenDisplay('File █\u0334█\u0338█ sealed E+.').text, 'File redacted sealed E+.');
});
test('combined proof cannot omit a base letter, grade qualifier or stage even with a fresh outer hash', () => {
  const source = 'S\u0334ealed ██ E+', original = renderSpokenDisplay(source);
  for (const change of ['Sealed redacted E', 'Sealed invented E+']) {
    const value = structuredClone(original); value.text = change;
    const { fingerprint: _fingerprint, ...content } = value; value.fingerprint = fingerprint(content);
    assert.throws(() => verifySpokenDisplay(source, value), /exact source and policies/);
  }
  assert.throws(() => verifySpokenDisplay(source, { ...original, stages: original.stages.slice(1) }), /exact source and policies/);
});
