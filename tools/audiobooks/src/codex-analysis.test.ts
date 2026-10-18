import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodexAnalysis, subscriptionArguments, type CodexAnalysisRequest } from './codex-analysis.js';

const request: CodexAnalysisRequest = { model: 'gpt-6.1-sol', instructions: 'Synthetic instructions', input: 'Synthetic source', schema: { type: 'object' } };
async function fixture(mode: 'success' | 'hold' | 'ignore-term') {
  const root = await mkdtemp(join(tmpdir(), 'codex-analysis-test-'));
  const executable = join(root, 'fake-codex'), pid = join(root, 'pid'), terminated = join(root, 'terminated');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
process.stdin.resume();
${mode === 'success' ? `fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1], '{"ok":true}');console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:2}}));process.exit(0);` : `process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(terminated)},'yes');${mode === 'hold' ? 'process.exit(0);' : ''}});setInterval(()=>{},1000);`}
fs.writeFileSync(${JSON.stringify(pid)}, String(process.pid));
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { root, executable, pid, terminated };
}
async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { const value = await readFile(path, 'utf8'); if (/^[1-9]\d*$/.test(value)) return Number(value); } catch { /* Child has not published its ready marker yet. */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Synthetic child did not start');
}
async function withExecutable<T>(executable: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.AUDIOBOOK_CODEX_BIN;
  process.env.AUDIOBOOK_CODEX_BIN = executable;
  try { return await body(); }
  finally { if (previous === undefined) delete process.env.AUDIOBOOK_CODEX_BIN; else process.env.AUDIOBOOK_CODEX_BIN = previous; }
}
function gone(pid: number): boolean { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } }

test('subscription direction requests can bound time and select medium reasoning', async () => {
  assert.ok(subscriptionArguments('/synthetic', { ...request, reasoningEffort: 'medium' }).includes('model_reasoning_effort="medium"'));
  assert.ok(subscriptionArguments('/synthetic', request).includes('model_reasoning_effort="high"'));
  const f = await fixture('success'), before = [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')];
  try {
    const result = await withExecutable(f.executable, () => runCodexAnalysis({ ...request, reasoningEffort: 'medium', timeoutMs: 4000 }));
    assert.deepEqual(result.value, { ok: true }); assert.equal(result.authentication, 'chatgpt');
    assert.deepEqual([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')], before);
    await assert.rejects(runCodexAnalysis({ ...request, timeoutMs: 1_200_001 }), /timeout must/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('aborted subscription waits for its owned child and removes process handlers', async () => {
  const f = await fixture('hold'), controller = new AbortController(), before = [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')];
  try {
    await withExecutable(f.executable, async () => {
      const pending = runCodexAnalysis({ ...request, signal: controller.signal });
      const rejected = assert.rejects(pending, /interrupted.*no API fallback/);
      const pid = await waitForPid(f.pid); controller.abort(); await rejected;
      assert.equal(await readFile(f.terminated, 'utf8'), 'yes'); assert.equal(gone(pid), true);
    });
    assert.deepEqual([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')], before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('subscription timeout escalates when its child ignores termination', async () => {
  const f = await fixture('ignore-term');
  try {
    await withExecutable(f.executable, async () => {
      const pending = runCodexAnalysis({ ...request, timeoutMs: 4000 });
      const rejected = assert.rejects(pending, /timeout.*no API fallback/);
      const pid = await waitForPid(f.pid); await rejected;
      assert.equal(await readFile(f.terminated, 'utf8'), 'yes'); assert.equal(gone(pid), true);
    });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('stopping a planner process terminates its subscription child before exit', async () => {
  const f = await fixture('hold'), entry = join(f.root, 'planner.mjs');
  await writeFile(entry, `import {runCodexAnalysis} from ${JSON.stringify(new URL('./codex-analysis.js', import.meta.url).href)};try{await runCodexAnalysis(${JSON.stringify(request)})}catch(error){console.log(error.message);process.exitCode=1}`);
  const child = spawn(process.execPath, [entry], { env: { ...process.env, AUDIOBOOK_CODEX_BIN: f.executable }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close'); let output = ''; child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.resume();
  try {
    const pid = await waitForPid(f.pid); child.kill('SIGTERM'); const [code] = await closed;
    assert.equal(code, 1); assert.match(output, /interrupted.*no API fallback/); assert.equal(gone(pid), true);
  } finally { child.kill('SIGKILL'); await rm(f.root, { recursive: true, force: true }); }
});


test('gateway direction reasoning and streaming cancellation obey the same request bounds', async () => {
  const keys = ['AI_GATEWAY_ORIGIN', 'AI_GATEWAY_CLIENT_ID', 'AI_GATEWAY_USER_ID', 'AI_GATEWAY_TOKEN'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let calls = 0, accepted: (() => void) | undefined;
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      assert.equal(JSON.parse(body).reasoning.effort, 'medium'); calls++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (calls === 1) res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }] } }) + '\n\n');
      else { res.write(': still processing\n\n'); accepted?.(); }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  Object.assign(process.env, { AI_GATEWAY_ORIGIN: `http://127.0.0.1:${address.port}`, AI_GATEWAY_CLIENT_ID: 'audiobook-worker', AI_GATEWAY_USER_ID: 'owner@example.test', AI_GATEWAY_TOKEN: 'synthetic-service-credential' });
  try {
    assert.deepEqual((await runCodexAnalysis({ ...request, reasoningEffort: 'medium' })).value, { ok: true });
    const controller = new AbortController(), started = new Promise<void>(resolve => { accepted = resolve; });
    const pending = runCodexAnalysis({ ...request, reasoningEffort: 'medium', signal: controller.signal });
    const rejected = assert.rejects(pending, /interrupted.*no API fallback/);
    await started; controller.abort(); await rejected; assert.equal(calls, 2);
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
