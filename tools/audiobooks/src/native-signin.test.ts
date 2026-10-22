import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeSignIn, signInChallenge, nativeRedirects } from './native-signin.js';
import { Store, sha } from './store.js';

test('native sign-in binds browser return, verifier, state, owner and device revocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-signin-'));
  try {
    const store = new Store(root), service = new NativeSignIn(store, 'https://listener.example.test');
    const verifier = 'a'.repeat(43), state = 'b'.repeat(43);
    await assert.rejects(service.start({ challenge: signInChallenge(verifier), state, redirectUri: 'https://attacker.example/callback' }));
    const started = await service.start({ challenge: signInChallenge(verifier), state, redirectUri: nativeRedirects[0]! });
    const redirect = new URL(await service.authorize(started.request, 'reader@example.test'));
    assert.equal(redirect.origin, 'null'); assert.equal(redirect.searchParams.get('state'), state);
    const proof = { request: started.request, verifier, state, code: redirect.searchParams.get('code')! };
    await assert.rejects(service.exchange({ ...proof, verifier: 'c'.repeat(43) }, () => true));
    await assert.rejects(service.exchange({ ...proof, state: 'c'.repeat(43) }, () => true));
    await assert.rejects(service.exchange({ ...proof, code: 'c'.repeat(43) }, () => true));
    await assert.rejects(service.exchange(proof, () => false));
    await assert.rejects(service.authorize(started.request, 'other@example.test'));
    const result = await service.exchange(proof, () => true);
    assert.equal(result.accountKey, sha('reader@example.test'));
    assert.deepEqual(await service.exchange(proof, () => true), result, 'Lost exchange response is retryable with the same proof');
    assert.equal((await store.read<{ owner: string }>(`devices/${sha(result.token)}.json`))?.owner, 'reader@example.test');
    await service.cancel(proof);
    await assert.rejects(service.exchange(proof, () => true));
    assert.equal((await store.read<{ revoked: boolean }>(`devices/${sha(result.token)}.json`))?.revoked, true);
    const expired = await service.start({ challenge: signInChallenge(verifier), state, redirectUri: nativeRedirects[0]! });
    const grant = (await store.read<Record<string, unknown>>(`signins/${expired.request}.json`))!;
    await store.write(`signins/${expired.request}.json`, { ...grant, expires: Date.now() - 1 });
    await assert.rejects(service.authorize(expired.request, 'reader@example.test'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
