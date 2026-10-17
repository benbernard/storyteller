import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { chapterSchema, type Cast } from './schema.js';
import { analyzeFrontier, frontierPolicySchema } from './frontier-analysis.js';

const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' }, model: { type: 'string' }, budget: { type: 'string' }, 'budget-id': { type: 'string' }, 'input-price': { type: 'string' }, 'output-price': { type: 'string' } } });
if (!values.input || !values.output || !values.model || !values.budget || !values['budget-id']) throw new Error('Use --input JSON --output DIRECTORY --model MODEL --budget USD --budget-id ID --input-price USD_PER_MILLION --output-price USD_PER_MILLION');
const input = JSON.parse(await readFile(values.input, 'utf8')) as { chapter: unknown; cast: Cast; context: string };
const policy = frontierPolicySchema.parse({ provider: 'api', model: values.model, budgetId: values['budget-id'], maxUsd: Number(values.budget), usdPerMillionInputTokens: values['input-price'] === undefined ? undefined : Number(values['input-price']), usdPerMillionOutputTokens: values['output-price'] === undefined ? undefined : Number(values['output-price']) });
const store = new Store(resolve(values.output));
await store.lock(async () => {
  const result = await analyzeFrontier(store, chapterSchema.parse(input.chapter), input.cast, input.context, policy);
  await store.write(`results/${policy.model}-${result.analysis.source}.json`, result);
  console.log(JSON.stringify({ model: policy.model, spans: result.analysis.spans.length, profiles: result.profiles.length, fingerprint: result.analysis.fingerprint }));
});
