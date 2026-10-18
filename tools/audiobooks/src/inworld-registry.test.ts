import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, sha } from './store.js';
import { historicalCast, reconcileCharacters, canonicalizeEstablishedProfileNames } from './inworld-registry.js';
import { type Chapter, type Cast } from './schema.js';
import type { FrontierResult } from './frontier-analysis.js';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export function registryFixture(id: string, sequence: number, name = id): { chapter: Chapter; result: FrontierResult } {
  const text = `“Hello,” said ${name}.`;
  const chapter: Chapter = { schemaVersion: 1, fictionId: 'book-1', chapterId: `chapter-${sequence}`, sequence, url: `https://example.org/${sequence}`, title: `Chapter ${sequence}`, text, contentHash: sha(text), retrievedAt: new Date().toISOString() };
  const profile = { id, name, aliases: [], portrayal: 'Source-supported speaker', importance: 'minor' as const, tags: [], evidence: text, continuityFrom: null };
  const result: FrontierResult = { profiles: [profile], analysis: { schemaVersion: 1, source: chapter.contentHash, fingerprint: '', model: 'fixture', promptVersion: 'test', characters: [profile], aliasUpdates: [], summary: `${name} spoke.`, spans: [
    { uid: 'speech-' + id, start: 0, end: 8, text: text.slice(0, 8), kind: 'dialogue', speaker: id, certainty: 'attributed', confidence: 1, reason: 'Explicit tag' },
    { uid: 'prose-' + id, start: 8, end: text.length, text: text.slice(8), kind: 'prose', speaker: 'narrator', certainty: 'attributed', confidence: 1, reason: 'Narration' },
  ] } };
  return { chapter, result };
}
test('concurrent character publication preserves both writers and replay preserves source identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inworld-registry-')), store = new Store(root);
  try {
    const first = registryFixture('mira', 1), second = registryFixture('rhea', 2);
    await Promise.all([reconcileCharacters(store, first.chapter, first.result), reconcileCharacters(store, second.chapter, second.result)]);
    assert.deepEqual((await store.read<Cast>('cast.json'))?.members.map(member => member.id).sort(), ['mira', 'rhea']);
    const replay = await reconcileCharacters(store, first.chapter, first.result);
    assert.deepEqual(replay.result, first.result);
    assert.deepEqual(replay.event.added, ['mira']);
    assert.equal((await store.read<Cast>('cast.json'))?.members.length, 2);
    assert.equal((await store.list('inworld-character-registry/events')).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('only a demonstrably dead registry owner is recovered; a live writer remains exclusive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inworld-registry-')), store = new Store(root), registry = new Store(store.path('inworld-character-registry'));
  try {
    const deadPid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', '']);
      const pid = child.pid;
      child.once('error', reject); child.once('exit', () => pid ? resolve(pid) : reject(Error('Missing child PID')));
    });
    await registry.write('writer.lock/owner.json', { pid: deadPid, startedAt: new Date().toISOString() });
    const fixture = registryFixture('mira', 1);
    await reconcileCharacters(store, fixture.chapter, fixture.result);
    assert.equal((await store.read<Cast>('cast.json'))?.members.length, 1);
    await registry.write('writer.lock/owner.json', { pid: process.pid, startedAt: new Date().toISOString() });
    let complete = false;
    const pending = reconcileCharacters(store, fixture.chapter, fixture.result).then(() => { complete = true; });
    await delay(120); assert.equal(complete, false);
    assert.equal((await registry.read<{ pid: number }>('writer.lock/owner.json'))?.pid, process.pid);
    await rm(registry.path('writer.lock'), { recursive: true });
    await pending; assert.equal(complete, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('explicit established names reuse saved IDs and voices without disclosing future aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inworld-registry-')), store = new Store(root);
  try {
    const original = registryFixture('mira', 1, 'Mira');
    await reconcileCharacters(store, original.chapter, original.result);
    const cast = (await store.read<Cast>('cast.json'))!;
    cast.members[0]!.aliases.push({ name: 'Hidden Queen', from: { chapter: 5, offset: 0 } });
    cast.members[0]!.voices.push({ voiceId: 'saved-female', settings: { stability: 0.5, similarity_boost: 0.7, style: 0, use_speaker_boost: true, speed: 1 }, version: 'one', from: { chapter: 1, offset: 0 }, reason: 'Saved casting', provenance: 'Owner review' });
    await store.write('cast.json', cast);
    assert.deepEqual(historicalCast(cast, 2).members[0]!.aliases, []);
    const later = registryFixture('new-mira-id', 2, 'Mira');
    const reconciled = await reconcileCharacters(store, later.chapter, later.result);
    assert.equal(reconciled.result.analysis.spans[0]!.speaker, 'mira');
    assert.equal(reconciled.result.analysis.characters.length, 0);
    const saved = (await store.read<Cast>('cast.json'))!;
    assert.deepEqual(saved.members[0]!.voices, cast.members[0]!.voices);
    assert.equal(saved.members.length, 1);
    const unsupported = registryFixture('invented', 3); unsupported.result.profiles[0]!.evidence = 'Absent evidence';
    await assert.rejects(reconcileCharacters(store, unsupported.chapter, unsupported.result), /evidence/);
    assert.equal((await store.read<Cast>('cast.json'))!.members.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('reconciling an earlier occurrence replaces future description facts while preserving saved casting and dated aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inworld-registry-')), store = new Store(root);
  try {
    const future = registryFixture('mira', 5, 'Mira');
    await reconcileCharacters(store, future.chapter, future.result);
    const cast = (await store.read<Cast>('cast.json'))!, member = cast.members[0]!;
    member.portrayal = 'Secretly the future queen'; member.evidence = 'Future revelation'; member.importance = 'major'; member.continuityFrom = 'concealed:future';
    member.aliases = [{ name: 'Hidden Queen', from: { chapter: 5, offset: 0 } }, { name: 'Mira', from: { chapter: 5, offset: 0 } }];
    member.voices = [{ voiceId: 'saved-female', settings: { stability: 0.5, similarity_boost: 0.7, style: 0, use_speaker_boost: true, speed: 1 }, version: 'one', from: { chapter: 1, offset: 0 }, reason: 'Saved casting', provenance: 'Owner review' }];
    await store.write('cast.json', cast);
    const earlier = registryFixture('mira', 1, 'Mira'); earlier.result.profiles[0]!.aliases = ['Mira'];
    await reconcileCharacters(store, earlier.chapter, earlier.result);
    const saved = (await store.read<Cast>('cast.json'))!, historical = historicalCast(saved, 1).members[0]!;
    assert.equal(historical.portrayal, 'Source-supported speaker');
    assert.equal(historical.evidence, earlier.chapter.text); assert.equal(historical.importance, 'minor');
    assert.equal(historical.continuityFrom, undefined);
    assert.deepEqual(historical.aliases, [{ name: 'Mira', from: { chapter: 1, offset: 0 } }]);
    assert.deepEqual(saved.members[0]!.voices, member.voices);
    assert.deepEqual(saved.members[0]!.aliases.find(alias => alias.name === 'Hidden Queen')?.from, { chapter: 5, offset: 0 });
    assert.equal(saved.members.length, 1);
    const invalidEarlier = registryFixture('rhea', 1, 'Rhea'); invalidEarlier.result.profiles[0]!.aliases = ['Future Empress'];
    await assert.rejects(reconcileCharacters(store, invalidEarlier.chapter, invalidEarlier.result), /aliases require explicit/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('an exact established ID survives another canonical short name while unknown IDs stay ambiguous', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inworld-registry-')), store = new Store(root);
  try {
    const established = registryFixture('zephyr_quinn', 1, 'Zephyr Quinn'), duplicate = registryFixture('quinn', 2, 'Quinn');
    await reconcileCharacters(store, established.chapter, established.result);
    // The historical import had a duplicate short-name entry before retaining
    // the already voiced full identity. Keep both records and their provenance.
    await reconcileCharacters(store, duplicate.chapter, duplicate.result);
    const cast = (await store.read<Cast>('cast.json'))!;
    const original = cast.members.find(member => member.id === 'zephyr_quinn')!;
    original.aliases.push({ name: 'Quinn', from: { chapter: 1, offset: 0 } });
    original.voices = [{ voiceId: 'saved-known-voice', settings: { stability: 0.5, similarity_boost: 0.7, style: 0, use_speaker_boost: true, speed: 1 }, version: 'one', from: { chapter: 1, offset: 0 }, reason: 'Saved casting', provenance: 'Owner review' }];
    await store.write('cast.json', cast);
    const returning = registryFixture('zephyr_quinn', 3, 'Quinn'); returning.result.analysis.characters = [];
    const reconciled = await reconcileCharacters(store, returning.chapter, returning.result);
    assert.equal(reconciled.result.analysis.spans[0]!.speaker, 'zephyr_quinn');
    assert.deepEqual((await store.read<Cast>('cast.json'))!.members, cast.members);
    const compatible = canonicalizeEstablishedProfileNames(cast, returning.chapter, returning.result);
    assert.equal(compatible.profiles[0]!.id, 'zephyr_quinn'); assert.equal(compatible.profiles[0]!.name, 'Zephyr Quinn');
    assert.deepEqual(compatible.analysis, returning.result.analysis);
    assert.equal(returning.result.profiles[0]!.name, 'Quinn'); // Pure repair, original evidence retained.
    const unknown = registryFixture('unestablished_quinn', 3, 'Quinn');
    await assert.rejects(reconcileCharacters(store, unknown.chapter, unknown.result), /Ambiguous established/);
    assert.throws(() => canonicalizeEstablishedProfileNames(cast, unknown.chapter, unknown.result), /no established matching ID/);
    // A generic label matching multiple canonical names remains unresolved even
    // for the compatibility helper; it cannot manufacture a unique full name.
    cast.members.find(member => member.id === 'quinn')!.name = 'Zephyr Quinn';
    cast.members.find(member => member.id === 'quinn')!.aliases.push({ name: 'Quinn', from: { chapter: 2, offset: 0 } });
    assert.throws(() => canonicalizeEstablishedProfileNames(cast, returning.chapter, returning.result), /canonical name remains ambiguous/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
