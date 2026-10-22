import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { Store, sha } from './store.js';

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const signInStart = z.object({ challenge: opaque, state: opaque, redirectUri: z.string().max(200) }).strict();
export const signInExchange = z.object({ request: opaque, state: opaque, verifier: opaque, code: opaque }).strict();
export const signInCancel = signInExchange.omit({ code: true });
export const nativeRedirects = ['io.github.benbernard.audiobooklistener.signin://callback', 'com.crabanddog.listener.signin://callback'];
type Grant = z.infer<typeof signInStart> & { expires: number; owner?: string; codeHash?: string; tokenHash?: string; cancelled?: boolean };
type Device = { owner: string; name: string; createdAt: string; revoked?: boolean };
const fresh = (): string => randomBytes(32).toString('base64url');
export const signInChallenge = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

/** A browser login returns a one-time code, never a device token, to an allowlisted app URI.
 * PKCE protects intercepted callbacks; state binds the response to the initiating app attempt.
 * Call these mutations through the listener's serialized state queue.
 */
export class NativeSignIn {
  constructor(private readonly store: Store, private readonly origin: string, private readonly redirects: readonly string[] = nativeRedirects) {}
  async start(input: z.infer<typeof signInStart>): Promise<{ request: string; url: string; expiresAt: number }> {
    if (!this.redirects.includes(input.redirectUri)) throw new Error('bad_request');
    const request = fresh(), expiresAt = Date.now() + 600000;
    await this.store.write(`signins/${request}.json`, { ...input, expires: expiresAt } satisfies Grant);
    return { request, url: `${this.origin}/listen/signin?request=${request}`, expiresAt };
  }
  private async grant(request: string): Promise<Grant> {
    opaque.parse(request);
    const grant = await this.store.read<Grant>(`signins/${request}.json`);
    if (!grant || grant.cancelled || grant.expires <= Date.now()) throw new Error('bad_request');
    return grant;
  }
  async authorize(request: string, owner: string): Promise<string> {
    const grant = await this.grant(request);
    if ((grant.owner && grant.owner !== owner) || grant.tokenHash) throw new Error('bad_request');
    const code = fresh();
    grant.owner = owner; grant.codeHash = sha(code);
    await this.store.write(`signins/${request}.json`, grant);
    const redirect = new URL(grant.redirectUri);
    redirect.searchParams.set('code', code); redirect.searchParams.set('state', grant.state);
    return redirect.href;
  }
  private async proof(input: z.infer<typeof signInCancel>): Promise<Grant> {
    const grant = await this.grant(input.request);
    if (grant.state !== input.state || signInChallenge(input.verifier) !== grant.challenge) throw new Error('bad_request');
    return grant;
  }
  async exchange(input: z.infer<typeof signInExchange>, mayListen: (owner: string) => boolean): Promise<{ token: string; accountKey: string }> {
    const grant = await this.proof(input);
    if (!grant.owner || grant.codeHash !== sha(input.code) || !mayListen(grant.owner)) throw new Error('bad_request');
    // A lost response can retry the same proof; no second device credential is created.
    const token = createHash('sha256').update(`signin:${input.verifier}:${input.request}:${input.code}`).digest('base64url');
    const tokenHash = sha(token), previous = await this.store.read<Device>(`devices/${tokenHash}.json`);
    if (previous?.revoked || (grant.tokenHash && grant.tokenHash !== tokenHash)) throw new Error('bad_request');
    if (!previous) await this.store.write(`devices/${tokenHash}.json`, { owner: grant.owner, name: 'Android listener', createdAt: new Date().toISOString() } satisfies Device);
    grant.tokenHash = tokenHash;
    await this.store.write(`signins/${input.request}.json`, grant);
    return { token, accountKey: sha(grant.owner) };
  }
  async cancel(input: z.infer<typeof signInCancel>): Promise<void> {
    const grant = await this.proof(input);
    grant.cancelled = true;
    if (grant.tokenHash) {
      const device = await this.store.read<Device>(`devices/${grant.tokenHash}.json`);
      if (device) await this.store.write(`devices/${grant.tokenHash}.json`, { ...device, revoked: true });
    }
    await this.store.write(`signins/${input.request}.json`, grant);
  }
}
