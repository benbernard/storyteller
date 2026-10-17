import { lookup } from 'node:dns';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent, fetch as safeFetch } from 'undici';
import ipaddr from 'ipaddr.js';
import { royalUrl } from './pages.js';

export type GetPage = (url: string) => Promise<string>;
export type GetImage = (url: string) => Promise<{ bytes: Buffer; mime: string }>;
export function publicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function imageUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Image must use public HTTPS.');
  if (ipaddr.isValid(url.hostname.replace(/^\[|\]$/g, '')) && !publicAddress(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('Private image address blocked.');
  return url;
}
const imageAgent = new Agent({ connect: { lookup(hostname, options, callback) {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) { callback(error, [], 0); return; }
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) { callback(new Error('Private image address blocked.'), [], 0); return; }
    // Pass the checked resolution directly to the socket. Never resolve again.
    if (options.all) callback(null, addresses); else callback(null, addresses[0]!.address, addresses[0]!.family);
  });
} } });
export function retryDelay(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const ms = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}
interface RequestOptions { signal?: AbortSignal; intervalMs?: number; attempts?: number; sleep?: (ms: number) => Promise<unknown>; request?: typeof fetch }
export function requests(options: RequestOptions = {}) {
  let last = 0;
  const sleep = options.sleep ?? ((ms: number) => delay(ms, undefined, {signal: options.signal}));
  const interval = options.intervalMs ?? 2000;
  return async (source: string, image = false): Promise<{ bytes: Buffer; mime: string }> => {
    let url = image ? imageUrl(source).href : royalUrl(source).href;
    for (let redirects = 0; redirects < 5; redirects++) {
      for (let attempt = 0; attempt < (options.attempts ?? 3); attempt++) {
        options.signal?.throwIfAborted();
        await sleep(Math.max(0, last + interval - Date.now())); last = Date.now();
        options.signal?.throwIfAborted();
        let response: Response;
        try {
          const init = { redirect: 'manual' as const, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), headers: { 'user-agent': 'HomelabRoyalRoad/2.0 (personal offline reader)', accept: image ? 'image/*' : 'text/html' } };
          response = options.request ? await options.request(url, init) : image ? await safeFetch(url, { ...init, dispatcher: imageAgent }) as unknown as Response : await fetch(url, init);
        } catch {
          options.signal?.throwIfAborted();
          if (attempt + 1 >= (options.attempts ?? 3)) throw new Error('Network request failed after bounded retries.');
          await sleep(1000 * 2 ** attempt); continue;
        }
        if ([301,302,303,307,308].includes(response.status)) {
          const location = response.headers.get('location'); await response.body?.cancel();
          if (!location) throw new Error('Redirect without destination.');
          const next = new URL(location, url).href;
          url = image ? imageUrl(next).href : royalUrl(next).href;
          break;
        }
        if (!response.ok) {
          const wait = retryDelay(response.headers.get('retry-after')) ?? 1000 * 2 ** attempt;
          await response.body?.cancel();
          if (![429,500,502,503,504].includes(response.status) || attempt + 1 >= (options.attempts ?? 3)) throw new Error(`HTTP ${response.status}; request stopped.`);
          // Long server cooldowns end the job instead of holding it or retrying too soon.
          if (wait > 60_000) throw new Error(`HTTP ${response.status}; server requests a longer cooldown. Retry later.`);
          await sleep(wait); continue;
        }
        const mime = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
        if (image ? !mime.startsWith('image/') && mime !== 'application/octet-stream' : mime !== 'text/html') { await response.body?.cancel(); throw new Error(image ? 'Expected an image response.' : 'Expected HTML from Royal Road.'); }
        const reader = response.body?.getReader(); if (!reader) throw new Error('Empty response.');
        const limitMb = image ? 100 : 20;
        const chunks: Uint8Array[] = []; let length = 0;
        try {
          while (true) { const item = await reader.read(); if (item.done) break; length += item.value.length; if (length > limitMb * 1024 * 1024) throw new Error(`Response exceeds ${limitMb} MB.`); chunks.push(item.value); }
        } finally { await reader.cancel(); }
        return { bytes: Buffer.concat(chunks), mime };
      }
    }
    throw new Error('Too many redirects.');
  };
}
export function httpClient(intervalMs = 2000, signal?: AbortSignal): GetPage {
  const request = requests({ intervalMs, signal }); return async url => (await request(url)).bytes.toString('utf8');
}
export function imageClient(signal?: AbortSignal): GetImage {
  const request = requests({ signal });
  return async url => {
    if (url.startsWith('data:')) {
      const data = /^data:(image\/(?:png|jpeg|gif|webp|avif));base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
      if (!data || data[2]!.length > 28_000_000) throw new Error('Unsupported embedded image.');
      return { bytes: Buffer.from(data[2]!, 'base64'), mime: data[1]! };
    }
    return request(url, true);
  };
}
export function verifyImage(bytes: Buffer): string {
  const signatures: Record<string, () => boolean> = {
    'image/png': () => bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
    'image/jpeg': () => bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    'image/gif': () => /^GIF8[79]a$/.test(bytes.subarray(0,6).toString()),
    'image/webp': () => bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP',
    'image/avif': () => bytes.subarray(4,8).toString() === 'ftyp' && /avif|avis/.test(bytes.subarray(8,40).toString()),
    'image/svg+xml': () => /<svg[\s>]/i.test(bytes.subarray(0,4096).toString()),
  };
  const actual = Object.entries(signatures).find(([,matches]) => matches());
  if (!actual) throw new Error('Unsupported or invalid image bytes.');
  return actual[0];
}
