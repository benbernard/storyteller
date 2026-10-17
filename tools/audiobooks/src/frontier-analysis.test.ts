import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeFrontier, frontierPolicySchema, restoreFrontier } from './frontier-analysis.js';
import { Store, sha } from './store.js';
import { type Chapter, type Cast } from './schema.js';
import { noteText, chapterPresentation } from './local-presentation.js';
const text = '“Yes,” Lucas said.\n\nCorvus nodded. “Proceed.”';
const chapter: Chapter = { schemaVersion: 1, fictionId: 'rr-1', chapterId: 'c1', sequence: 1, title: 'Chapter 1: Arrival', url: 'https://www.royalroad.com/fiction/1', text, contentHash: sha(text), retrievedAt: new Date().toISOString() };
const cast: Cast = { schemaVersion: 1, members: [] };
const label = { kind: 'prose', speaker: 'narrator', certainty: 'attributed', confidence: 1, reason: 'Narration' };
const profile = (id: string, evidenceUnit: number) => ({ id, name: id, aliases: [], portrayal: 'An adult man speaking in the scene.', importance: 'supporting', tags: ['male', 'adult'], evidenceUnit, continuityFrom: null });
const raw = { characters: [profile('lucas', 1), profile('corvus', 2)], aliasUpdates: [], summary: 'Lucas and Corvus spoke.', labels: {
  unit_0: { ...label, kind: 'dialogue', speaker: 'lucas' }, unit_1: label, unit_2: label, unit_3: { ...label, kind: 'dialogue', speaker: 'corvus' },
} };
test('frontier attribution preserves source and refuses silent narrator/dialogue coercion', () => {
  const result = restoreFrontier(raw, chapter, cast);
  assert.equal(result.analysis.spans.map(s => s.text).join(''), text);
  assert.deepEqual(result.analysis.spans.map(s => s.speaker), ['lucas', 'narrator', 'narrator', 'corvus']);
  assert.throws(() => restoreFrontier({ ...raw, labels: { ...raw.labels, unit_1: { ...label, kind: 'dialogue', speaker: 'lucas' } } }, chapter, cast), /narrator text/);
});
test('author notes preserve their positions and reject mismatched source records', async () => {
  assert.equal(noteText('<div>A note from X</div><p>Hello<br>again</p><script>bad</script>'), 'A note from X\n\nHello\nagain');
  const root = await mkdtemp(join(tmpdir(), 'notes-')); const store = new Store(root);
  try {
    const record = { chapter, before: '<p>Before</p>', after: '<p>After</p>' }, key = sha(JSON.stringify(record));
    await store.write(`records/${key}.json`, record); await store.write('manifest.json', { details: { c1: key } });
    assert.deepEqual(await chapterPresentation(store, chapter), { before: 'Before', after: 'After', archiveRecord: key });
    await assert.rejects(chapterPresentation(store, { ...chapter, contentHash: '0'.repeat(64) }), /match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('paid analysis reserves before request, records usage, caches success and enforces the shared cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frontier-')); const store = new Store(root), oldKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'test';
  try {
    const policy = frontierPolicySchema.parse({ provider: 'api', usdPerMillionInputTokens: 0.1, usdPerMillionOutputTokens: 0.5, model: 'gpt-6-luna', budgetId: 'test', maxUsd: 1 }); let calls = 0;
    const request: typeof fetch = async (_url, init) => {
      calls++; const ledger = await store.read<{ charges: { status: string }[] }>('frontier-budgets/test.json'); assert.equal(ledger?.charges[0]?.status, 'pending');
      const body = JSON.parse(String(init?.body)); assert.equal(body.model, 'gpt-6-luna'); assert.equal(body.service_tier, 'default');
      return Response.json({ status: 'completed', usage: { input_tokens: 1000, output_tokens: 1000 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(raw) }] }] });
    };
    await analyzeFrontier(store, chapter, cast, '', policy, undefined, request);
    await analyzeFrontier(store, chapter, cast, '', policy, undefined, request); assert.equal(calls, 1);
    await assert.rejects(analyzeFrontier(store, chapter, cast, 'New context', { ...policy, maxUsd: 0.00001 }, undefined, request), /budget exhausted/); assert.equal(calls, 1);
  } finally { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; await rm(root, { recursive: true, force: true }); }
});

test('collective speech and character thoughts follow explicit rendering policy', () => {
  const collective = '“Yes!” they answered in unison.';
  const result = restoreFrontier({ characters: [], aliasUpdates: [], summary: '', labels: {
    unit_0: { ...label, kind: 'dialogue', speaker: 'the group' }, unit_1: label,
  } }, { ...chapter, text: collective, contentHash: sha(collective) }, cast);
  assert.equal(result.analysis.spans[0]!.speaker, 'anonymous');
  const thoughts = restoreFrontier({ ...raw, labels: { ...raw.labels, unit_2: { ...label, kind: 'thought', speaker: 'corvus' } } }, chapter, cast);
  assert.equal(thoughts.analysis.spans[2]!.speaker, 'narrator');
});

test('production defaults to Sol on the subscription and never falls back to the API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subscription-')); const store = new Store(root);
  const policy = frontierPolicySchema.parse({}); let apiCalls = 0; let subscriptionCalls = 0;
  const request: typeof fetch = async () => { apiCalls++; throw new Error('API must not be called'); };
  try {
    assert.equal(policy.model, 'gpt-6.1-sol'); assert.equal(policy.provider, 'codex-subscription');
    const result = await analyzeFrontier(store, chapter, cast, '', policy, undefined, request, async input => {
      subscriptionCalls++; assert.equal(input.model, 'gpt-6.1-sol');
      return { value: raw, usage: { input_tokens: 100 }, authentication: 'chatgpt' };
    });
    assert.equal(result.analysis.spans.map(s => s.text).join(''), text);
    await analyzeFrontier(store, chapter, cast, '', policy, undefined, request, async () => { throw new Error('Cached result should be reused'); });
    assert.equal(subscriptionCalls, 1); assert.equal(apiCalls, 0);
    assert.deepEqual(await store.list('frontier-budgets'), []);
    await assert.rejects(analyzeFrontier(store, chapter, cast, 'changed', policy, undefined, request, async () => { throw new Error('Subscription limit reached'); }), /Subscription limit reached/);
    assert.equal(apiCalls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { subscriptionArguments, subscriptionEnvironment } from './codex-analysis.js';
test('subscription invocation removes API credentials and forces ChatGPT authentication', () => {
  const source = { OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', OPENAI_BASE_URL: 'https://other.invalid', CODEX_HOME: '/auth' };
  const env = subscriptionEnvironment(source);
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.CODEX_API_KEY, undefined); assert.equal(env.OPENAI_BASE_URL, undefined);
  assert.equal(env.CODEX_HOME, '/auth'); assert.equal(source.OPENAI_API_KEY, 'secret');
  const args = subscriptionArguments('/work', { model: 'gpt-6.1-sol', instructions: '', input: '', schema: {} });
  for (const required of ['--ignore-user-config', '--ephemeral', 'forced_login_method="chatgpt"', 'read-only', 'shell_tool', 'plugins', 'multi_agent', '--output-schema']) assert(args.includes(required));
});


test('speech tags do not cross paragraph boundaries into reported conversation', () => {
  for (const gap of ['\n\n', '\n  \n']) {
    const text = '“We will know soon.”' + gap + 'Patrik asked after Orvyn.';
    const value = { characters: [profile('veyra', 0), profile('patrik', 1)], aliasUpdates: [], summary: '', labels: {
      unit_0: { ...label, kind: 'dialogue', speaker: 'veyra' }, unit_1: label,
    } };
    const result = restoreFrontier(value, { ...chapter, text, contentHash: sha(text) }, cast);
    assert.equal(result.analysis.spans[0]!.speaker, 'veyra');
    assert.equal(result.analysis.spans.map(s => s.text).join(''), text);
    const inline = text.replace(gap, ' ');
    assert.throws(() => restoreFrontier(value, { ...chapter, text: inline, contentHash: sha(inline) }, cast), /Explicit speech tag identifies patrik/);
  }
});

test('Sol can split single-quoted and unquoted speech from its narration without changing source', () => {
  for (const text of ["'Come back,' Thea said.", 'Come back, Thea said.', "'Come back,\" Thea said."]) {
    const end = text.indexOf(' Thea');
    const value = { characters: [profile('thea', 0)], aliasUpdates: [], summary: '', labels: {
      unit_0: { ...label, parts: [
        { ...label, end, kind: 'dialogue', speaker: 'thea', reason: 'Explicit speech tag and context establish spoken words despite nonstandard punctuation.' },
        { ...label, end: text.length },
      ] },
    } };
    const result = restoreFrontier(value, { ...chapter, text, contentHash: sha(text) }, cast);
    assert.equal(result.analysis.spans.map(s => s.text).join(''), text);
    assert.deepEqual(result.analysis.spans.map(s => s.speaker), ['thea', 'narrator']);
    assert.equal(result.analysis.spans[0]!.end, end);
    assert.throws(() => restoreFrontier({ ...value, labels: { unit_0: { ...label, parts: value.labels.unit_0.parts.slice(0, 1) } } }, { ...chapter, text, contentHash: sha(text) }, cast), /cover source unit/);
  }
});

test('single quoted thoughts and written excerpts remain narrator even when a character is named', () => {
  const text = "'I should leave,' Thea thought.";
  const result = restoreFrontier({ characters: [], aliasUpdates: [], summary: '', labels: {
    unit_0: { ...label, kind: 'thought', speaker: 'thea', parts: null },
  } }, { ...chapter, text, contentHash: sha(text) }, cast);
  assert.equal(result.analysis.spans[0]!.speaker, 'narrator');
});

import { semanticBoundaryEnds, unitResponseSchema } from './analysis-units.js';
test('semantic coordinates expose actual UTF-16 boundaries and constrain each unit independently', () => {
  const text = "😀 'Come back,' Thea said.";
  const ends = semanticBoundaryEnds(text);
  assert(ends.includes(text.length));
  assert(!ends.includes(1));
  assert(ends.includes(text.indexOf(' Thea')));
  const schema = JSON.stringify(unitResponseSchema(1, true, [text]));
  assert(schema.includes(`"maximum":${text.length}`));
});
