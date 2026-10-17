import {test} from "node:test";
import assert from "node:assert/strict";
import {request} from "node:http";
import {once} from "node:events";
import {mkdtemp, mkdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomBytes} from "node:crypto";
import {listenerIdentity} from "./listener-identity.js";
import {createListener} from "./listener.js";
import {Store, sha} from "./store.js";

const origin = "https://stories.example.test";
const config = {uid: "immutable-owner", email: "current@example.test", accountEmail: "existing@example.test", peers: "127.0.0.1,::1"};
const headers = {Host: "stories.example.test", "X-authentik-uid": config.uid, "X-Forwarded-User": config.email};

test("verified proxy identity preserves existing progress and device ownership while rejecting spoofing", async () => {
  const root = await mkdtemp(join(tmpdir(), "listener-identity-"));
  const state = new Store(join(root, "state")), fictions = join(root, "fictions");
  await mkdir(fictions);
  await state.write(`users/${sha(config.accountEmail)}.json`, {positions: {}, completed: {saved: true}, seen: {}, issues: []});
  const token = randomBytes(32).toString("base64url");
  await state.write(`devices/${sha(token)}.json`, {owner: config.accountEmail, name: "Existing phone", createdAt: new Date().toISOString()});
  const server = createListener(fictions, state, listenerIdentity(origin, config), origin);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address === "object");
  const call = (path: string, requestHeaders: Record<string, string>, method = "GET"): Promise<{status: number; body: string}> => new Promise((resolve, reject) => {
    const req = request({hostname: "127.0.0.1", port: address.port, path, method, headers: requestHeaders}, response => {
      const parts: Buffer[] = [];
      response.on("data", (part: Buffer) => parts.push(part));
      response.on("end", () => resolve({status: response.statusCode!, body: Buffer.concat(parts).toString()}));
    });
    req.on("error", reject); req.end();
  });
  try {
    const verified = await call("/listen/library", headers);
    assert.equal(verified.status, 200);
    const library = JSON.parse(verified.body) as {accountKey: string; state: {completed: {saved: boolean}}};
    assert.equal(library.accountKey, sha(config.accountEmail));
    assert.equal(library.state.completed.saved, true);
    const changedHeaders: Record<string, string>[] = [{"X-authentik-uid": "other"}, {"X-Forwarded-User": "other@example.test"},
      {Host: "attacker.example.test"}, {Authorization: "Bearer fabricated"}, {"X-authentik-uid": "immutable-owner, other"}];
    for (const changed of changedHeaders)
      assert.equal((await call("/listen/library", {...headers, ...changed})).status, 401);
    assert.equal((await call("/listen/library", {Host: headers.Host, "X-Forwarded-User": config.email})).status, 401);
    assert.equal((await call("/listen/pair/approve", {...headers, Origin: "https://attacker.example.test"}, "POST")).status, 403);
    assert.equal((await call("/api/listener/library", headers)).status, 401);
    assert.equal((await call("/api/listener/library", {Authorization: `Bearer ${token}`})).status, 200);
    assert.equal((await call("/api/listener/devices/revoke", {Authorization: `Bearer ${token}`}, "POST")).status, 200);
    assert.equal((await call("/api/listener/library", {Authorization: `Bearer ${token}`})).status, 401);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, {recursive: true, force: true});
  }
});

test("peer trust is exact, IPv4-mapped addresses normalize, and incomplete configuration fails closed", () => {
  const identity = listenerIdentity(origin, config);
  const mock = {headers: {host: headers.Host, "x-authentik-uid": config.uid, "x-forwarded-user": config.email}, socket: {remoteAddress: "::ffff:127.0.0.1"}};
  assert.equal(identity(mock), config.accountEmail);
  mock.socket.remoteAddress = "127.0.0.2";
  assert.equal(identity(mock), null);
  for (const change of [{uid: ""}, {email: "ambiguous,identity@example.test"}, {accountEmail: ""}, {peers: "127.0.0.0/8"}, {peers: ""}])
    assert.throws(() => listenerIdentity(origin, {...config, ...change}));
});
