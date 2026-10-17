import {createHash, timingSafeEqual} from "node:crypto";
import type {IncomingMessage} from "node:http";
import {isIP} from "node:net";

type BrowserRequest = Pick<IncomingMessage, "headers"> & {socket: Pick<IncomingMessage["socket"], "remoteAddress">};
export type BrowserOwner = (request: BrowserRequest) => string | null;
export interface ListenerIdentity {
  uid: string;
  email: string;
  accountEmail: string;
  peers: string;
}

function peer(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.startsWith("::ffff:") && isIP(normalized.slice(7)) === 4) return normalized.slice(7);
  if (isIP(normalized) === 4) return normalized;
  if (isIP(normalized) === 6) return new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
  throw new Error("Listener proxy peers must be exact IP addresses");
}

/** Explicit immutable identity -> existing progress account; never infer from email alone. */
export function listenerIdentity(origin: string, config: ListenerIdentity): BrowserOwner {
  const host = new URL(origin).host;
  const validEmail = (email: string): boolean => /^[^\s,@]+@[^\s,@]+\.[^\s,@]+$/.test(email) && email === email.toLowerCase();
  if (!config.uid || config.uid.length > 256 || /[\s,]/u.test(config.uid) ||
      !validEmail(config.email) || !validEmail(config.accountEmail))
    throw new Error("Listener requires the pinned Authentik identity and existing account email");
  const peers = new Set(config.peers.split(",").map(value => value.trim()).filter(Boolean).map(peer));
  if (!peers.size) throw new Error("Listener requires exact trusted proxy peers");
  return (request) => {
    if (request.headers.host !== host || request.headers.authorization !== undefined ||
        request.headers["x-authentik-uid"] !== config.uid ||
        request.headers["x-forwarded-user"] !== config.email) return null;
    let address: string;
    try {address = peer(request.socket.remoteAddress ?? "");} catch {return null;}
    return peers.has(address) ? config.accountEmail : null;
  };
}

/** Single-household login. The HTTP listener must sit behind HTTPS off loopback. */
export function basicIdentity(origin: string, username: string, password: string): BrowserOwner {
  if (!username || username.includes(':') || password.length < 24) throw new Error('Set a username and a password of at least 24 characters');
  const host = new URL(origin).host;
  const expected = createHash('sha256').update(username + ':' + password).digest();
  return request => {
    if (request.headers.host !== host) return null;
    const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(request.headers.authorization ?? '');
    if (!match) return null;
    const actual = createHash('sha256').update(Buffer.from(match[1]!, 'base64')).digest();
    return timingSafeEqual(actual, expected) ? username : null;
  };
}
