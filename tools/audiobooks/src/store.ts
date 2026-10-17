import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename, rm, readdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const fingerprint = (value: unknown) => sha(canonical(value));
export async function commitDirectory(temporary: string, destination: string) {
  await rename(temporary, destination);
  const directory = await open(dirname(destination), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function atomic(path: string, value: string | Buffer) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export class Store {
  constructor(readonly root: string) {}
  path(...parts: string[]) {
    const result = resolve(this.root, ...parts);
    if (!result.startsWith(resolve(this.root) + sep)) throw new Error('Unsafe state path');
    return result;
  }
  async read<T>(path: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(this.path(path), 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async write(path: string, value: unknown) { await atomic(this.path(path), JSON.stringify(value, null, 2) + '\n'); }
  async object(kind: string, value: unknown) {
    const key = fingerprint(value), path = `${kind}/${key}.json`;
    if (!await this.read(path)) await this.write(path, value);
    return key;
  }
  async list(kind: string) {
    try { return (await readdir(this.path(kind))).filter(n => n.endsWith('.json')).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async lock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.path('writer.lock');
    try { await mkdir(path); } catch { throw new Error('State is locked. Check for an active worker before using unlock.'); }
    await atomic(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    try { return await fn(); } finally { await rm(path, { recursive: true, force: true }); }
  }
}
