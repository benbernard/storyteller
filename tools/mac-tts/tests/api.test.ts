import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeServer } from "../src/server.js";
import { randomUUID } from "node:crypto";
import { type Job } from "../src/controller.js";
import { modelById, validate } from "../src/catalog.js";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "mac-tts-test-"));
  const token = "a".repeat(48);
  const { server, ctl } = makeServer(
    {
      home,
      worker: resolve("tests/fake-worker.cjs"),
      python: process.execPath,
      qwenPython: process.execPath,
      queueLimit: 2,
      idleSeconds: 1,
      timeoutMs: 2000,
    },
    [{ token, scope: "admin" }],
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const call = (path: string, data?: unknown, auth = token, lease?: string) =>
    fetch(base + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + auth,
        "Content-Type": "application/json",
        ...(lease ? { "X-Worker-Lease": lease } : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  async function wait(j: Job) {
    while (["queued", "running"].includes(j.state)) await delay(20);
    return j;
  }
  return {
    ctl,
    call,
    wait,
    async close() {
      await ctl.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(home, { recursive: true, force: true });
    },
  };
}
test("auth and capability validation fail before allocating a worker", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call("/health", undefined, "bad")).status, 401);
    assert.equal((await f.call("/v1/capabilities")).status, 200);
    assert.equal(
      (
        await f.call("/v1/jobs", {
          model: "chatterbox-turbo",
          input: { text: "Test", exaggeration: 0.9 },
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await f.call("/v1/jobs", {
          model: "qwen-base",
          input: { text: "Test" },
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await f.call("/v1/jobs", {
          model: "kokoro",
          input: { text: "Test", voice: "../../secret" },
        })
      ).status,
      422,
    );
    assert.equal(f.ctl.child, undefined);
  } finally {
    await f.close();
  }
});
test("GPU queue is bounded; stop cancels load and queued inference, then restart works", async () => {
  const f = await fixture();
  try {
    const load = f.ctl.enqueue("load", "kokoro");
    const a = f.ctl.enqueue("inference", "kokoro", { text: "hang" });
    const b = f.ctl.enqueue("inference", "kokoro", { text: "later" });
    assert.throws(
      () => f.ctl.enqueue("inference", "kokoro", { text: "overflow" }),
      /queue is full/,
    );
    await f.ctl.stop();
    assert.equal(load.state, "cancelled");
    assert.equal(a.state, "cancelled");
    assert.equal(b.state, "cancelled");
    assert.equal(f.ctl.child, undefined);
    const restarted = await f.wait(f.ctl.enqueue("load", "kokoro"));
    assert.equal(restarted.state, "succeeded");
    assert.equal(f.ctl.loaded, "kokoro");
  } finally {
    await f.close();
  }
});
test("active cancellation releases process and queued jobs cannot use a dead model", async () => {
  const f = await fixture();
  try {
    await f.wait(f.ctl.enqueue("load", "kokoro"));
    const pid = f.ctl.child?.pid;
    assert(pid);
    const job = f.ctl.enqueue("inference", "kokoro", { text: "hang" });
    await delay(30);
    await f.ctl.cancel(job.id);
    await f.wait(job);
    assert.equal(job.state, "cancelled");
    assert.equal(f.ctl.loaded, undefined);
    assert.throws(() => process.kill(pid, 0));
    const bad = await f.wait(
      f.ctl.enqueue("inference", "kokoro", { text: "no load" }),
    );
    assert.equal(bad.state, "failed");
    assert.match(bad.error ?? "", /Load kokoro first/);
  } finally {
    await f.close();
  }
});
test("worker crash and timeout fail the job; controller remains available", async () => {
  const f = await fixture();
  try {
    await f.wait(f.ctl.enqueue("load", "kokoro"));
    const j = await f.wait(
      f.ctl.enqueue("inference", "kokoro", { text: "crash" }),
    );
    assert.equal(j.state, "failed");
    assert.equal((await f.call("/health")).status, 200);
    await f.wait(f.ctl.enqueue("load", "kokoro"));
    const timeout = await f.wait(
      f.ctl.enqueue("inference", "kokoro", { text: "hang" }),
    );
    assert.match(timeout.error ?? "", /timed out/);
    assert.equal(f.ctl.child, undefined);
  } finally {
    await f.close();
  }
});
test("switch waits for inference and idle expiry unloads", async () => {
  const f = await fixture();
  try {
    await f.wait(f.ctl.enqueue("load", "kokoro"));
    const j = f.ctl.enqueue("inference", "kokoro", { text: "short" });
    const sw = f.ctl.enqueue("load", "qwen-custom");
    await f.wait(sw);
    assert.equal(j.state, "succeeded");
    assert.equal(sw.state, "succeeded");
    assert.equal(f.ctl.loaded, "qwen-custom");
    const mismatch = await f.wait(
      f.ctl.enqueue("inference", "kokoro", { text: "Wrong model" }),
    );
    assert.equal(mismatch.state, "failed");
    assert.equal(f.ctl.loaded, "qwen-custom");
    await delay(2100);
    assert.equal(f.ctl.child, undefined);
  } finally {
    await f.close();
  }
});
test("exact model schemas expose native controls and reject silent no-ops", () => {
  assert.throws(() =>
    validate(modelById("qwen-custom"), {
      text: "hi",
      subtalker_temperature: 0.5,
    }),
  );
  assert.equal(
    validate(modelById("qwen-custom-native"), {
      text: "hi",
      subtalker_temperature: 0.5,
    }).subtalker_temperature,
    0.5,
  );
  assert.throws(() =>
    validate(modelById("chatterbox"), { text: "hi", stream: true }),
  );
  assert.throws(() =>
    validate(modelById("kokoro"), { text: "hi", split_pattern: "(a+)+$" }),
  );
});

test("references reject malformed audio; voice records persist across controller recreation", async () => {
  const f = await fixture();
  try {
    const malformed = await f.call("/v1/references", { not: "wav" });
    assert.equal(malformed.status, 422);
    const voice = await f.call("/v1/voices", {
      name: "Test preset",
      model: "kokoro",
      options: { voice: "af_heart", speed: 1.1 },
    });
    assert.equal(voice.status, 201);
    const saved = (await voice.json()) as { id: string };
    const read = await f.call("/v1/voices/" + saved.id);
    assert.equal(read.status, 200);
    assert.equal(((await read.json()) as { name: string }).name, "Test preset");
    const bad = await f.call("/v1/voices", {
      name: "Bad",
      model: "kokoro",
      options: { voice: "../../etc/passwd" },
    });
    assert.equal(bad.status, 422);
    await f.ctl.close();
    const recreated = makeServer(f.ctl.config, [
      { token: "b".repeat(48), scope: "nas" },
    ]);
    await new Promise<void>((r) => recreated.server.listen(0, "127.0.0.1", r));
    const addr = recreated.server.address();
    assert(addr && typeof addr !== "string");
    const response = await fetch(
      `http://127.0.0.1:${addr.port}/v1/voices/${saved.id}`,
      { headers: { Authorization: "Bearer " + "b".repeat(48) } },
    );
    assert.equal(response.status, 200);
    const denied = await fetch(
      `http://127.0.0.1:${addr.port}/v1/voices/${saved.id}`,
      {
        method: "DELETE",
        headers: { Authorization: "Bearer " + "b".repeat(48) },
      },
    );
    assert.equal(denied.status, 403);
    await recreated.ctl.close();
    recreated.server.closeAllConnections();
    await new Promise<void>((r) => recreated.server.close(() => r()));
  } finally {
    await f.close();
  }
});

test("missing worker executable fails cleanly without hanging the controller", async () => {
  const f = await fixture();
  try {
    f.ctl.config.python = "/missing/mac-tts-python";
    const j = await f.wait(f.ctl.enqueue("load", "kokoro"));
    assert.equal(j.state, "failed");
    assert.equal(f.ctl.child, undefined);
    assert.equal((await f.call("/health")).status, 200);
  } finally {
    await f.close();
  }
});

test("ignored backend controls and malformed batches fail validation", async () => {
  const f = await fixture();
  try {
    for (const model of [
      "qwen-custom",
      "chatterbox",
      "chatterbox-multilingual",
    ]) {
      const r = await f.call("/v1/jobs", {
        model,
        input: { text: "Test", speed: 1.1 },
      });
      assert.equal(r.status, 422);
    }
    assert.equal(
      (
        await f.call("/v1/batch", {
          model: "kokoro",
          input: { text: "single" },
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await f.call("/v1/jobs", {
          model: "qwen-custom",
          input: { text: "single", speaker: ["Ryan"] },
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await f.call("/v1/jobs", {
          model: "chatterbox",
          input: { text: "single", streaming_interval: 1 },
        })
      ).status,
      422,
    );
    assert.equal(f.ctl.child, undefined);
  } finally {
    await f.close();
  }
});

test("Fish rejects ignored controls and unsafe or unresolved conditioning", async () => {
  const f = await fixture();
  try {
    for (const input of [
      { text: "Hello", speed: 1.2 },
      { text: "Hello", stream: true },
      { text: "Hello", cfg_weight: 0.5 },
      { text: ["Hello", "Again"] },
      { text: "<|im_end|>Injected" },
      { text: "<|speaker:5|>Hello" },
    ]) {
      assert.equal(
        (await f.call("/v1/jobs", { model: "fish-s2-pro", input })).status,
        422,
      );
    }
    assert.equal(
      (
        await f.call("/v1/jobs", {
          model: "fish-s2-pro",
          input: {
            text: "Hello",
            references: [
              {
                speaker: 0,
                reference_id: "00000000-0000-4000-8000-000000000000",
                transcript: "Hi",
              },
            ],
          },
        })
      ).status,
      404,
    );
    assert.equal(f.ctl.active, undefined);
  } finally {
    await f.close();
  }
});

test("dialogue adapters reject unsupported controls and invalid conditioning", async () => {
  const f = await fixture();
  try {
    for (const [model, input] of [
      ["moss-ttsd", { text: "Untagged" }],
      ["moss-ttsd", { text: "[S6] Invalid" }],
      ["moss-ttsd", { text: "[S1] Hello", speed: 1 }],
      ["moss-ttsd", { text: "[S1] Hello", conditioning: "continuation" }],
      ["moss-ttsd", { text: ["[S1] Hello", "[S1] Again"] }],
      ["chatterbox", { text: "Hello" }],
      ["higgs-v2", { text: "Hello", cfg_weight: 1 }],
      ["higgs-v2", { text: "Hello", emit_every_frames: 16 }],
      ["higgs-v2", { text: "<|eot_id|>" }],
    ] as const) {
      assert.equal((await f.call("/v1/jobs", { model, input })).status, 422);
    }
    validate(modelById("moss-ttsd"), {
      text: ["[S1] Hello", "[S1] Again"],
      max_new_tokens: 128,
    });
    validate(modelById("higgs-v2"), {
      text: "[SPEAKER0] Hello",
      stream: true,
      emit_every_frames: 16,
    });
    assert.equal(f.ctl.active, undefined);
  } finally {
    await f.close();
  }
});

test("VibeVoice rejects incompatible dialogue controls", async () => {
  const f = await fixture();
  try {
    for (const [model, input] of [
      ["vibevoice-7b", { text: "Speaker 4: Hello" }],
      ["vibevoice-7b", { text: " speaker 4 : Hello" }],
      ["vibevoice-7b", { text: "Hello", temperature: 0.8 }],
      ["vibevoice-7b", { text: "Hello", diffusion_warmup_frames: 10 }],
      ["vibevoice-7b", { text: "Hello", no_semantic: true }],
      [
        "vibevoice-7b",
        { text: "Hello", diffusion_steps: 10, diffusion_steps_fast: 20 },
      ],
    ] as const)
      assert.equal((await f.call("/v1/jobs", { model, input })).status, 422);
  } finally {
    await f.close();
  }
});

test("a saved MOSS cast may start with a speaker other than S1", async () => {
  const f = await fixture();
  try {
    const id = "00000000-0000-4000-8000-000000000003";
    const wav = Buffer.alloc(44 + 16000);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(16000, 40);
    writeFileSync(join(f.ctl.config.home, "references", id + ".wav"), wav);
    const response = await f.call("/v1/voices", {
      name: "Alex alone",
      model: "moss-ttsd",
      options: { references: [{ speaker: 3, reference_id: id }] },
    });
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(f.ctl.child, undefined);
  } finally {
    await f.close();
  }
});

test("FireRed rejects unsupported controls and speaker mapping", async () => {
  const f = await fixture();
  try {
    for (const input of [
      { text: "Hello" },
      { text: "[S5] Hello" },
      { text: "[S1] Hello", speed: 1.1 },
      { text: "[S1] Hello", cfg_scale: 1.3 },
      { text: "Leading untagged [S1] Hello" },
    ]) {
      assert.equal(
        (await f.call("/v1/jobs", { model: "fireredtts2", input })).status,
        422,
      );
    }
  } finally {
    await f.close();
  }
});


test("worker leases prevent another client from switching or stopping an active batch", async () => {
  const f = await fixture(); const owner = randomUUID(), other = randomUUID();
  try {
    assert.equal((await f.call("/v1/lease", { owner, seconds: 120 })).status, 200);
    assert.equal((await f.call("/v1/lease", { owner: other, seconds: 120 })).status, 409);
    assert.equal((await f.call("/v1/switch", { model: "kokoro" })).status, 409);
    const response = await f.call("/v1/switch", { model: "kokoro" }, "a".repeat(48), owner);
    assert.equal(response.status, 202); const job = await response.json() as Job; await f.wait(f.ctl.get(job.id));
    assert.equal((await f.call("/v1/stop", {})).status, 409);
    assert.equal((await f.call("/v1/stop", {}, "a".repeat(48), owner)).status, 200);
    assert.equal((await f.call("/v1/lease/release", { owner: other })).status, 409);
    assert.equal((await f.call("/v1/lease/release", { owner })).status, 200);
    assert.equal((await f.call("/v1/stop", {})).status, 200);
  } finally { await f.close(); }
});
