/** Stable account keys are storage identities, independent of the login provider. */
export interface ListenerPermissions {
  listen: boolean;
  manageLibrary: boolean;
  generate: boolean;
  paidGenerate: boolean;
}
export const ownerPermissions: Readonly<ListenerPermissions> = Object.freeze({ listen: true, manageLibrary: true, generate: true, paidGenerate: false });
export interface ListenerIntegrations {
  permissions?: (account: string) => Readonly<ListenerPermissions>;
  /** Informational only: permissions are enforced separately on every request. */
  capabilities?: { sources?: string[]; generation?: string[]; updates?: 'manual' | 'managed' };
  revision?: string;
  /** Private filesystem socket, limited to continuation operations for one configured account. */
  continuationControl?: {socket:string;owner:string};
}

/** BookOrbit is optional. Its deployment origin never belongs in stored product code. */
export function bookOrbitOrigin(value = process.env.BOOKORBIT_PUBLIC_URL ?? 'https://books.example.org'): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('BOOKORBIT_PUBLIC_URL must be an HTTPS origin without credentials, path, query or fragment');
  return url.origin;
}
export function bookOrbitUrl(id: number, origin = bookOrbitOrigin()): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid BookOrbit book ID');
  return `${origin}/book/${id}`;
}
export function bookOrbitId(value: string, origin = bookOrbitOrigin()): number | null {
  const url = new URL(value);
  const match = /^\/book\/([1-9]\d*)$/.exec(url.pathname);
  if (url.origin !== origin || url.username || url.password || url.search || url.hash || !match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}
