import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, sha } from './store.js';
import { literalCompoundUnit, numericComparatorOffsets, renderSourceNotation, verifySourceNotation } from './spoken-notation.js';

test('numeric spoken view changes only reviewed notation while conserving operands, case and ordinary text', () => {
  const source = '😀 exact <12h; -13.25°C; avg 9 abcd/efg; E+ ██ a\u0338.', unit = source.indexOf('abcd/efg');
  const result = renderSourceNotation(source, [unit]);
  assert.equal(result.text, '😀 exact less than 12h; -13.25 degrees Celsius; avg 9 lowercase ay bee see dee slash lowercase ee ef jee; E+ ██ a\u0338.');
  assert.equal(result.sourceHash, sha(source)); assert.deepEqual(verifySourceNotation(source, [unit], result), result);
  assert.equal(result.mapping.map(span => source.slice(span.sourceStart, span.sourceEnd)).join(''), source);
  assert.equal(result.mapping.map(span => result.text.slice(span.spokenStart, span.spokenEnd)).join(''), result.text);
  for (const span of result.mapping) if (span.kind === 'copy') assert.equal(source.slice(span.sourceStart, span.sourceEnd), result.text.slice(span.spokenStart, span.spokenEnd));
  assert.equal(result.mapping[0]!.sourceEnd, source.indexOf('<'));
  assert.equal(renderSourceNotation('ordinary abcd/efg').text, 'ordinary abcd/efg');
});

test('closed compound spelling never guesses an expansion or handles arbitrary words, case or lengths', () => {
  assert.equal(literalCompoundUnit('wxyz/abc'), 'lowercase double you ex why zee slash lowercase ay bee see');
  for (const value of ['abc/def', 'abcde/efg', 'Abcd/efg', 'abcd/EFG', 'abcd-efg', 'éabc/efg', 'ordinary']) assert.throws(() => literalCompoundUnit(value), /lowercase ASCII/);
  for (const offsets of [[1], [-1], [0, 0], [3, 0]]) assert.throws(() => renderSourceNotation('abcd/efg', offsets), /offset|lowercase ASCII/);
  for (const suffix of ['é', '\u0301', '𝔄', '9', '_']) assert.throws(() => renderSourceNotation('abcd/efg' + suffix, [0]), /complete token/);
  for (const prefix of ['é', '\u0301', '𝔄', '9', '_']) assert.throws(() => renderSourceNotation(prefix + 'abcd/efg', [prefix.length]), /complete token/);
  assert.throws(() => renderSourceNotation('xabcd/efgy', [1]), /complete token/);
});

test('canonical comparator eligibility refuses tags, equality, shifts, ambiguous numbers and inferred words', () => {
  for (const source of ['<tag>', '<=12', '<<12', '<-12', '<.75%', '<twelve', '<12.3.4', '<12>']) assert.throws(() => numericComparatorOffsets(source), /Unsupported/);
  assert.deepEqual(numericComparatorOffsets('prefix <12.75kg; suffix <3h.'), [7, 24]);
  assert.throws(() => numericComparatorOffsets('<twelve percent'), /Unsupported/);
  assert.equal(renderSourceNotation('<twelve percent').text, 'less than twelve percent'); // requires canonical binding
});

test('proof rejects changed operands, omitted ordinary words, shifted ranges and unit authorization', () => {
  const source = '😀 keep 9 abcd/efg at <12h and 13.25°C.', unit = source.indexOf('abcd/efg'), result = renderSourceNotation(source, [unit]);
  for (const text of [result.text.replace('12h', '13h'), result.text.replace('keep ', ''), result.text.replace('lowercase ', '')]) {
    const forged = { ...structuredClone(result), text, spokenHash: sha(text) }, { fingerprint: _old, ...content } = forged;
    forged.fingerprint = fingerprint(content); assert.throws(() => verifySourceNotation(source, [unit], forged), /exact source/);
  }
  assert.throws(() => verifySourceNotation(source, [], result), /exact source/);
  assert.throws(() => verifySourceNotation(source + '!', [unit], result), /exact source/);
});
