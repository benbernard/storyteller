import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bookOrbitOrigin, bookOrbitId, bookOrbitUrl, ownerPermissions, type ListenerPermissions} from './integrations.js';
import {createListener} from './listener.js';
import {Store, sha} from './store.js';

test('source links use the configured origin and reject foreign or ambiguous URLs', () => {
  const origin = bookOrbitOrigin('https://library.example.test');
  assert.equal(bookOrbitUrl(7, origin), 'https://library.example.test/book/7');
  assert.equal(bookOrbitId('https://library.example.test/book/7', origin), 7);
  for (const url of ['https://other.example.test/book/7', 'https://user@library.example.test/book/7', 'https://library.example.test/book/7?x=1', 'https://library.example.test/book/7#x', 'https://library.example.test/book/007']) assert.equal(bookOrbitId(url, origin), null);
  for (const url of ['http://library.example.test', 'https://user@library.example.test', 'https://library.example.test/path', 'https://library.example.test?x=1']) assert.throws(() => bookOrbitOrigin(url));
});

test('existing paired devices retain their account and current server permissions govern queue writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'integration-'));
  const state = new Store(join(root, 'state'));
  const owner = 'legacy@example.test', token = 'a'.repeat(43);
  await mkdir(join(root, 'fictions'));
  await state.write(`devices/${sha(token)}.json`, {owner, name: 'Existing phone', createdAt: '2026-01-01'});
  const saved = {positions: {}, completed: {'rr-7:rr-8': true}, seen: {}, issues: []};
  await state.write(`users/${sha(owner)}.json`, saved);
  let permissions: ListenerPermissions | undefined = {...ownerPermissions, manageLibrary: false, generate: false};
  const server = createListener(join(root, 'fictions'), state, () => owner, 'http://listener.example.test', join(root, 'archive'), false,
    {permissions: account => {assert.equal(account, owner); return permissions!;}, capabilities: {sources: ['bookorbit'], generation: ['qwen'], updates: 'managed'}, revision: 'test-pin'});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address === 'object');
  const base = 'http://127.0.0.1:' + address.port;
  const headers = {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Storyteller-Permissions': 'owner'};
  const post = (path: string, data: unknown) => fetch(base + '/api/listener' + path, {method: 'POST', headers, body: JSON.stringify(data)});
  try {
    const library = await (await fetch(base + '/api/listener/library', {headers})).json() as {accountKey: string; state: unknown};
    assert.equal(library.accountKey, sha(owner)); assert.deepEqual(library.state, saved);
    const capabilities = await (await fetch(base + '/api/listener/capabilities', {headers})).json() as {permissions: ListenerPermissions; updates: string};
    assert.equal(capabilities.permissions.generate, false); assert.equal(capabilities.updates, 'managed');
    const follow = {url: 'https://www.royalroad.com/fiction/7', enabled: true, mode: 'all'};
    assert.equal((await post('/follow', follow)).status, 403);
    assert.equal((await post('/audio', {story: 'rr-7', enabled: true})).status, 403);
    permissions = {...permissions, manageLibrary: true};
    assert.equal((await post('/follow', follow)).status, 403);
    assert.equal((await post('/follow', {...follow, mode: 'download'})).status, 200);
    permissions = {...permissions, generate: true};
    assert.equal((await post('/follow', follow)).status, 200);
    // Revoking access applies to an already paired device, without issuing a new token.
    permissions = {...permissions, listen: false};
    assert.equal((await fetch(base + '/api/listener/library', {headers})).status, 403);
    permissions = undefined; // A broken external adapter must fail closed.
    assert.equal((await fetch(base + '/api/listener/library', {headers})).status, 500);
    assert.deepEqual(await state.read(`users/${sha(owner)}.json`), saved);
  } finally {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, {recursive: true, force: true});}
});
