import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, sha } from './store.js';
import { combiningOverlayPolicy, renderCombiningOverlays, verifyCombiningOverlays } from './spoken-overlays.js';

test('overlay rendering removes only five stylistic marks and preserves every visible base character', () => {
  const source = 'S\u0334\u0337e\u0335a\u0336l\u0338ed E+ 4\u0338.';
  const originalHash = sha(source), result = renderCombiningOverlays(source);
  assert.equal(result.policy, combiningOverlayPolicy);
  assert.equal(result.text, 'Sealed E+ 4.');
  assert.equal(result.sourceHash, originalHash); assert.equal(result.spokenHash, sha(result.text));
  assert.equal(sha(source), originalHash);
  assert.deepEqual(result.mapping.filter(x => x.kind === 'overlay').map(x => x.sourceEnd - x.sourceStart), [2, 1, 1, 1, 1]);
  assert.deepEqual(verifyCombiningOverlays(source, result), result);
});
test('complete source-to-spoken coverage uses exact UTF16 offsets including zero-length deletion spans', () => {
  const source = '𐐀\u0334\u0338a\u0337Z', result = renderCombiningOverlays(source);
  assert.equal(result.text, '𐐀aZ');
  assert.equal(result.mapping[0]!.sourceEnd, 2);
  assert.equal(result.mapping.map(x => source.slice(x.sourceStart, x.sourceEnd)).join(''), source);
  assert.equal(result.mapping.map(x => result.text.slice(x.spokenStart, x.spokenEnd)).join(''), result.text);
  for (const [i, range] of result.mapping.entries()) {
    assert.equal(range.sourceStart, result.mapping[i - 1]?.sourceEnd ?? 0);
    assert.equal(range.spokenStart, result.mapping[i - 1]?.spokenEnd ?? 0);
    if (range.kind === 'overlay') {
      assert.equal(range.spokenStart, range.spokenEnd);
      assert.match(source.slice(range.sourceStart, range.sourceEnd), /^[\u0334-\u0338]+$/u);
    } else assert.equal(source.slice(range.sourceStart, range.sourceEnd), result.text.slice(range.spokenStart, range.spokenEnd));
  }
});
test('policy preserves semantic symbols, accents and hidden text while removing styling at every boundary', () => {
  for (const source of ['', 'E+ C++ ██ ?', 'é a\u0301 n\u0303', 'literal [unknown] 𐐀']) {
    assert.equal(renderCombiningOverlays(source).text, source);
  }
  assert.deepEqual(renderCombiningOverlays('').mapping, []);
  assert.equal(renderCombiningOverlays('\u0334“\u0335A\u0336 \u0337B\u0338.”').text, '“A B.”');
});
test('proof rejects changed source, inferred hidden words, omitted base letters, and shifted source spans', () => {
  const source = 'S\u0334e\u0337aled E+', result = renderCombiningOverlays(source);
  for (const text of ['Sealed E', 'Secret name E+', 'Seaed E+']) {
    const changed = structuredClone(result); changed.text = text; changed.spokenHash = sha(text);
    const { fingerprint: _hash, ...content } = changed; changed.fingerprint = fingerprint(content);
    assert.throws(() => verifyCombiningOverlays(source, changed), /exact source and policy/);
  }
  const changed = structuredClone(result); changed.mapping[1]!.sourceStart++;
  assert.throws(() => verifyCombiningOverlays(source, changed), /exact source and policy/);
  assert.throws(() => verifyCombiningOverlays(source + '.', result), /exact source and policy/);
});
