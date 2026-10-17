import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual, createHash, randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  statSync,
  renameSync,
  createReadStream,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Controller, ApiError, type Config, type Job } from "./controller.js";
import {
  capabilities,
  modelById,
  idSchema,
  validate,
  type Input,
} from "./catalog.js";
const object = z.record(z.string(), z.unknown());
const jobRequest = z.strictObject({ model: z.string(), input: object });
const voiceRequest = z.strictObject({
  name: z.string().min(1).max(120),
  model: z.string(),
  options: object,
  source_job_id: idSchema.optional(),
});
type Voice = z.infer<typeof voiceRequest> & { id: string; created: string };
type Auth = { token: string; scope: "admin" | "nas" }[];
function digest(s: string) {
  return createHash("sha256").update(s).digest();
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage, limit = 65536) {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const b = Buffer.from(part);
    size += b.length;
    if (size > limit) throw new ApiError(413, "Request body too large");
    parts.push(b);
  }
  return Buffer.concat(parts);
}
function parse(buffer: Buffer) {
  try {
    return JSON.parse(buffer.toString()) as unknown;
  } catch {
    throw new ApiError(400, "Invalid JSON");
  }
}
export function wavInfo(b: Buffer) {
  if (
    b.length < 44 ||
    b.toString("ascii", 0, 4) !== "RIFF" ||
    b.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new ApiError(422, "Upload a RIFF WAV file");
  let rate = 0,
    channels = 0,
    bits = 0,
    format = 0,
    size = 0;
  for (let p = 12; p + 8 <= b.length; ) {
    const n = b.readUInt32LE(p + 4),
      kind = b.toString("ascii", p, p + 4);
    if (p + 8 + n > b.length) throw new ApiError(422, "Truncated WAV");
    if (kind === "fmt " && n >= 16) {
      format = b.readUInt16LE(p + 8);
      channels = b.readUInt16LE(p + 10);
      rate = b.readUInt32LE(p + 12);
      bits = b.readUInt16LE(p + 22);
    }
    if (kind === "data") size += n;
    p += 8 + n + (n % 2);
  }
  if (
    ![1, 3].includes(format) ||
    ![1, 2].includes(channels) ||
    rate < 8000 ||
    rate > 96000 ||
    ![16, 24, 32].includes(bits) ||
    !size ||
    (format === 3 && bits !== 32)
  )
    throw new ApiError(
      422,
      "WAV must be PCM16/24/32 or float32, mono/stereo, 8–96 kHz",
    );
  const seconds = size / ((rate * channels * bits) / 8);
  if (seconds < 1 || seconds > 30)
    throw new ApiError(422, "Reference audio must be 1–30 seconds");
  return { sample_rate: rate, channels, duration_seconds: seconds };
}
export function makeServer(config: Config, auth: Auth) {
  const ctl = new Controller(config);
  const home = config.home;
  let lease: { owner: string; expires: number } | undefined;
  for (const folder of ["references", "voices", "audio", "prompts"])
    mkdirSync(join(home, folder), { recursive: true, mode: 0o700 });
  const readVoice = (id: string): Voice => {
    idSchema.parse(id);
    const path = join(home, "voices", id + ".json");
    if (!existsSync(path)) throw new ApiError(404, "Voice not found");
    return JSON.parse(readFileSync(path, "utf8")) as Voice;
  };
  function resolveInput(modelId: string, raw: unknown) {
    const model = modelById(modelId);
    let input = validate(model, raw);
    if (input.voice_id) {
      const voice = readVoice(String(input.voice_id));
      if (voice.model !== modelId)
        throw new ApiError(
          422,
          `Voice belongs to ${voice.model}; select that model`,
        );
      input = validate(model, { ...voice.options, ...input });
    }
    if (
      input.reference_id &&
      !existsSync(join(home, "references", String(input.reference_id) + ".wav"))
    )
      throw new ApiError(404, "Reference not found");
    if (
      model.mode === "turbo" &&
      input.reference_id &&
      wavInfo(
        readFileSync(
          join(home, "references", String(input.reference_id) + ".wav"),
        ),
      ).duration_seconds <= 5
    )
      throw new ApiError(
        422,
        "Chatterbox Turbo requires a reference longer than 5 seconds",
      );
    if (model.mode === "vibe") {
      const refs = (input.references ?? []) as {
        speaker: number;
        reference_id: string;
        transcript?: string;
      }[];
      const ids = new Set(refs.map((r) => r.speaker));
      if (ids.size !== refs.length)
        throw new ApiError(422, "Reference speaker IDs must be unique");
      if (refs.some((r, i) => r.speaker !== i))
        throw new ApiError(
          422,
          "VibeVoice references must be ordered Speaker 0, 1, 2, 3 without gaps",
        );
      let duration = 0;
      for (const ref of refs) {
        const path = join(home, "references", ref.reference_id + ".wav");
        if (!existsSync(path)) throw new ApiError(404, "Reference not found");
        duration += wavInfo(readFileSync(path)).duration_seconds;
        if (ref.transcript?.includes("<|"))
          throw new ApiError(422, "Reserved reference tokens");
      }
      if (duration > 60)
        throw new ApiError(
          422,
          "VibeVoice references must total at most 60 seconds",
        );
      if (
        (input.temperature !== undefined || input.top_p !== undefined) &&
        input.do_sample !== true
      )
        throw new ApiError(422, "temperature and top_p require do_sample=true");
      if (
        input.diffusion_warmup_frames !== undefined &&
        input.diffusion_steps_fast === undefined
      )
        throw new ApiError(
          422,
          "diffusion_warmup_frames requires diffusion_steps_fast",
        );
      const value = String(input.text);
      if (value.includes("<|"))
        throw new ApiError(422, "Reserved model tokens are not accepted");
      const tags = [...value.matchAll(/^\s*Speaker\s+(\d+)\s*:/gim)];
      for (const tag of tags) {
        const n = Number(tag[1]);
        const start = 0;
        const end = 3;
        if (n < start || n > end || (refs.length && !ids.has(n)))
          throw new ApiError(
            422,
            "Speaker tag has no matching supported reference",
          );
      }
      if (
        model.mode === "vibe" &&
        input.diffusion_steps_fast !== undefined &&
        Number(input.diffusion_steps_fast) > Number(input.diffusion_steps ?? 20)
      )
        throw new ApiError(
          422,
          "Fast diffusion steps cannot exceed full diffusion steps",
        );
    }
    if (["moss", "higgs", "firered"].includes(model.mode)) {
      const refs = (input.references ?? []) as {
        speaker: number;
        reference_id: string;
        transcript?: string;
      }[];
      const ids = new Set(refs.map((r) => r.speaker));
      if (ids.size !== refs.length)
        throw new ApiError(422, "Reference speaker IDs must be unique");
      let duration = 0;
      for (const ref of refs) {
        const path = join(home, "references", ref.reference_id + ".wav");
        if (!existsSync(path)) throw new ApiError(404, "Reference not found");
        duration += wavInfo(readFileSync(path)).duration_seconds;
        if (ref.transcript?.includes("<|"))
          throw new ApiError(
            422,
            "Reference transcript contains reserved tokens",
          );
      }
      if (duration > 60)
        throw new ApiError(
          422,
          "Dialogue references must total at most 60 seconds",
        );
      if (
        model.mode === "firered" &&
        !/^\s*\[S[1-4]\]/.test(String(input.text))
      )
        throw new ApiError(
          422,
          "FireRed text must start with a supported speaker tag",
        );
      const texts = Array.isArray(input.text) ? input.text : [input.text];
      for (const text of texts) {
        if (text.includes("<|"))
          throw new ApiError(
            422,
            "Reserved model tokens are not accepted; use documented speaker tags",
          );
        const tags = [
          ...text.matchAll(
            model.mode !== "higgs" ? /\[S(\d+)\]/g : /\[SPEAKER(\d+)\]/g,
          ),
        ];
        if (model.mode !== "higgs" && !tags.length)
          throw new ApiError(422, "Text requires documented [S1] speaker tags");
        for (const tag of tags) {
          const n = Number(tag[1]);
          const start = model.mode !== "higgs" ? 1 : 0;
          if (
            n < start ||
            n > (model.mode === "firered" ? 4 : start + 4) ||
            (refs.length && !ids.has(n))
          )
            throw new ApiError(
              422,
              "Speaker tag has no valid matching reference",
            );
        }
      }
      if (String(input.scene_prompt ?? "").includes("<|"))
        throw new ApiError(422, "Scene prompt contains reserved tokens");
      if (model.mode === "moss") {
        const mode =
          input.conditioning ?? (refs.length ? "voice_clone" : "generation");
        if (mode === "generation" && refs.length)
          throw new ApiError(
            422,
            "generation mode ignores references; select voice_clone",
          );
        if (mode !== "generation" && !refs.length)
          throw new ApiError(422, "Selected MOSS mode requires references");
        if (
          ["continuation", "voice_clone_and_continuation"].includes(
            String(mode),
          ) &&
          refs.some((r) => !r.transcript)
        )
          throw new ApiError(
            422,
            "Continuation requires every reference transcript",
          );
        if (Array.isArray(input.text) && input.use_kv_cache === true)
          throw new ApiError(
            422,
            "MOSS native batch has no KV cache; omit use_kv_cache or set false",
          );
        if (
          Array.isArray(input.text) &&
          Number(input.max_new_tokens ?? 2048) > 512
        )
          throw new ApiError(
            422,
            "Uncached native MOSS batch requires max_new_tokens <= 512",
          );
      } else if (
        !input.stream &&
        (input.emit_every_frames !== undefined ||
          input.overlap_ms !== undefined)
      )
        throw new ApiError(
          422,
          "emit_every_frames and overlap_ms require stream=true",
        );
    }
    if (model.mode === "fish") {
      const refs = (input.references ?? []) as {
        speaker: number;
        reference_id: string;
        transcript: string;
      }[];
      const speakers = new Set(refs.map((r) => r.speaker));
      if (speakers.size !== refs.length)
        throw new ApiError(422, "Fish reference speaker IDs must be unique");
      let duration = 0;
      for (const ref of refs) {
        const path = join(home, "references", ref.reference_id + ".wav");
        if (!existsSync(path))
          throw new ApiError(404, "Fish reference not found");
        duration += wavInfo(readFileSync(path)).duration_seconds;
        if (ref.transcript.includes("<|"))
          throw new ApiError(
            422,
            "Reference transcripts must not contain special tokens",
          );
      }
      if (duration > 90)
        throw new ApiError(
          422,
          "Fish references must total at most 90 seconds",
        );
      const text = String(input.text);
      const tokens = text.match(/<\|[^>]*>/g) ?? [];
      for (const token of tokens) {
        const match = /^<\|speaker:([0-4])\|>$/.exec(token);
        if (!match)
          throw new ApiError(
            422,
            "Fish permits only speaker:0 through speaker:4 special tokens",
          );
        if (refs.length && !speakers.has(Number(match[1])))
          throw new ApiError(
            422,
            "Each tagged speaker needs a matching reference",
          );
      }
      if (!tokens.length && refs.length && !speakers.has(0))
        throw new ApiError(
          422,
          "Untagged Fish text uses speaker 0; provide its reference",
        );
    }
    if (model.id === "chatterbox" && !input.reference_id)
      throw new ApiError(
        422,
        "This Chatterbox checkpoint requires reference_id or a saved voice_id; default conditioning is absent",
      );
    if (model.mode === "base") {
      if (!input.reference_id)
        throw new ApiError(
          422,
          "Base cloning requires reference_id or a saved voice_id",
        );
      if (!input.x_vector_only_mode && !input.ref_text)
        throw new ApiError(
          422,
          "Provide ref_text, or explicitly set x_vector_only_mode=true",
        );
      if (input.x_vector_only_mode && input.ref_text)
        throw new ApiError(
          422,
          "x_vector_only_mode and ref_text are mutually exclusive",
        );
      if (
        model.runtime === "mlx" &&
        input.ref_text &&
        Number(input.repetition_penalty ?? 1.5) < 1.5
      )
        throw new ApiError(
          422,
          "MLX ICL requires repetition_penalty >= 1.5; native adapter permits lower values",
        );
    }
    if (model.mode === "custom" && !input.speaker)
      throw new ApiError(422, "CustomVoice requires speaker");
    if (model.mode === "design" && !input.instruct)
      throw new ApiError(422, "VoiceDesign requires instruct");
    if (
      !Array.isArray(input.text) &&
      [input.speaker, input.instruct, input.language].some(Array.isArray)
    )
      throw new ApiError(422, "Array controls require a matching text array");
    if (Array.isArray(input.text)) {
      if (model.id === "qwen-base" && input.x_vector_only_mode)
        throw new ApiError(
          422,
          "MLX Base batching requires shared reference audio and transcript; use qwen-base-native for x-vector batches",
        );
      for (const key of ["language", "speaker", "instruct"]) {
        const value = input[key];
        if (Array.isArray(value) && value.length !== input.text.length)
          throw new ApiError(422, `${key} array must match text array length`);
      }
    }
    if (input.phonemes && input.split)
      throw new ApiError(
        422,
        "Kokoro phoneme input is already one chunk; omit split",
      );
    if (input.voice && input.blend)
      throw new ApiError(422, "Choose voice or blend");
    return input;
  }
  const server = createServer(async (req, res) => {
    try {
      const bearer =
        req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? "";
      const grant = auth.find((a) =>
        timingSafeEqual(digest(a.token), digest(bearer)),
      );
      if (!grant) throw new ApiError(401, "Bearer authentication required");
      if (req.headers.origin)
        throw new ApiError(403, "Browser-origin requests are not supported");
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method;
      if (method === "POST" && url.pathname === "/v1/lease") {
        const input = z.strictObject({ owner: z.uuid(), seconds: z.number().int().min(30).max(300).default(120) }).parse(parse(await body(req)));
        if (lease && lease.owner !== input.owner && lease.expires > Date.now()) throw new ApiError(409, "Another worker holds the GPU lease");
        if ((!lease || lease.owner !== input.owner) && (ctl.active || ctl.queue.length)) throw new ApiError(409, "Wait for the active GPU work before acquiring a lease");
        lease = { owner: input.owner, expires: Date.now() + input.seconds * 1000 };
        return json(res, 200, { expires: lease.expires });
      }
      if (method === "POST" && url.pathname === "/v1/lease/release") {
        const input = z.strictObject({ owner: z.uuid() }).parse(parse(await body(req)));
        if (lease && lease.owner !== input.owner) throw new ApiError(409, "The GPU lease belongs to another worker");
        if (ctl.active || ctl.queue.length) throw new ApiError(409, "Wait for your GPU job before releasing the lease");
        lease = undefined; return json(res, 200, { released: true });
      }
      if (method !== "GET" && lease && lease.expires > Date.now() && req.headers["x-worker-lease"] !== lease.owner)
        throw new ApiError(409, "Another worker holds the GPU lease");
      if (method === "GET" && ["/health", "/v1/status"].includes(url.pathname))
        return json(res, 200, {
          ok: true,
          ...ctl.status(),
          source_commit: process.env.MAC_TTS_COMMIT ?? "development",
        });
      if (
        method === "GET" &&
        ["/v1/models", "/v1/capabilities"].includes(url.pathname)
      )
        return json(res, 200, { models: capabilities() });
      if (
        method === "POST" &&
        ["/v1/start", "/v1/switch"].includes(url.pathname)
      ) {
        const { model } = z
          .strictObject({ model: z.string() })
          .parse(parse(await body(req)));
        return json(res, 202, ctl.view(ctl.enqueue("load", model)));
      }
      if (
        method === "POST" &&
        ["/v1/stop", "/v1/shutdown"].includes(url.pathname)
      ) {
        await ctl.stop();
        return json(res, 200, ctl.status());
      }
      if (
        method === "POST" &&
        ["/v1/jobs", "/v1/inference", "/v1/batch"].includes(url.pathname)
      ) {
        const data = jobRequest.parse(parse(await body(req, 256 * 1024)));
        const input = resolveInput(data.model, data.input);
        if (url.pathname === "/v1/batch" && !Array.isArray(input.text))
          throw new ApiError(
            422,
            "Batch inference requires an input.text array",
          );
        const job = ctl.enqueue("inference", data.model, input);
        if (url.pathname === "/v1/jobs") return json(res, 202, ctl.view(job));
        await waitJob(ctl, job);
        return json(res, job.state === "succeeded" ? 200 : 422, ctl.view(job));
      }
      if (parts[0] === "v1" && parts[1] === "jobs" && parts[2]) {
        idSchema.parse(parts[2]);
        const job = ctl.get(parts[2]);
        if (method === "GET" && parts.length === 3)
          return json(res, 200, ctl.view(job));
        if (method === "POST" && parts[3] === "cancel")
          return json(res, 200, await ctl.cancel(job.id));
        if (method === "GET" && parts[3] === "events") {
          res.writeHead(200, {
            "content-type": "application/x-ndjson",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          let next = 0;
          const send = () => {
            while (next < job.events.length) {
              const event = job.events[next++]!;
              if (res.writableLength > 2 * 1024 * 1024) {
                res.destroy();
                return;
              }
              res.write(JSON.stringify(event) + "\n");
            }
            if (["succeeded", "failed", "cancelled"].includes(job.state))
              res.end();
          };
          ctl.on(job.id, send);
          res.on("close", () => ctl.off(job.id, send));
          send();
          return;
        }
        if (method === "GET" && parts[3] === "audio") {
          const chunk = url.searchParams.get("chunk");
          if (chunk && !/^chunk-\d{4}\.wav$/.test(chunk))
            throw new ApiError(400, "Invalid chunk name");
          if (!chunk && job.state !== "succeeded")
            throw new ApiError(409, "Audio is not complete");
          const path = join(home, "audio", job.id, chunk ?? "output.wav");
          if (!existsSync(path)) throw new ApiError(404, "Audio not found");
          res.writeHead(200, {
            "content-type": "audio/wav",
            "content-length": statSync(path).size,
            "cache-control": "no-store",
          });
          createReadStream(path).pipe(res);
          return;
        }
      }
      if (parts[0] === "v1" && parts[1] === "references") {
        if (method === "POST" && parts.length === 2) {
          if (readdirSync(join(home, "references")).length >= 512)
            throw new ApiError(
              429,
              "Reference limit reached; remove unused references",
            );
          const b = await body(req, 12 * 1024 * 1024);
          const info = wavInfo(b);
          const id = randomUUID();
          writeFileSync(join(home, "references", id + ".wav"), b, {
            mode: 0o600,
            flag: "wx",
          });
          return json(res, 201, { id, ...info });
        }
        if (method === "GET" && parts.length === 2)
          return json(res, 200, {
            references: readdirSync(join(home, "references"))
              .filter((f) => f.endsWith(".wav"))
              .map((f) => ({
                id: f.slice(0, -4),
                ...wavInfo(readFileSync(join(home, "references", f))),
              })),
          });
        if (parts[2]) {
          idSchema.parse(parts[2]);
          const path = join(home, "references", parts[2] + ".wav");
          if (!existsSync(path)) throw new ApiError(404, "Reference not found");
          if (method === "GET") {
            res.writeHead(200, { "content-type": "audio/wav" });
            createReadStream(path).pipe(res);
            return;
          }
          if (method === "DELETE") {
            if (grant.scope !== "admin")
              throw new ApiError(
                403,
                "Deletion requires the local admin credential",
              );
            if (ctl.active || ctl.queue.length)
              throw new ApiError(
                409,
                "Wait for queued GPU work before deleting references",
              );
            for (const f of readdirSync(join(home, "voices"))) {
              const v = readVoice(f.slice(0, -5));
              if (
                v.options.reference_id === parts[2] ||
                (Array.isArray(v.options.references) &&
                  v.options.references.some(
                    (r: { reference_id?: string }) =>
                      r.reference_id === parts[2],
                  ))
              )
                throw new ApiError(409, "Reference is used by a saved voice");
            }
            unlinkSync(path);
            return json(res, 200, { deleted: true });
          }
        }
      }
      if (parts[0] === "v1" && parts[1] === "voices") {
        if (method === "POST" && parts.length === 2) {
          const data = voiceRequest.parse(parse(await body(req)));
          if ("text" in data.options || "voice_id" in data.options)
            throw new ApiError(
              422,
              "Voice options cannot contain text or voice_id",
            );
          if (readdirSync(join(home, "voices")).length >= 512)
            throw new ApiError(429, "Voice limit reached");
          if (data.source_job_id) {
            const source = ctl.get(data.source_job_id);
            if (
              source.state !== "succeeded" ||
              !source.model.startsWith("qwen-design")
            )
              throw new ApiError(
                422,
                "source_job_id must be a completed Qwen voice design job",
              );
            if (!data.model.startsWith("qwen-base"))
              throw new ApiError(
                422,
                "Designed audio becomes a stable voice through a Qwen Base model",
              );
            const b = readFileSync(
              join(home, "audio", source.id, "output.wav"),
            );
            wavInfo(b);
            const reference = randomUUID();
            writeFileSync(join(home, "references", reference + ".wav"), b, {
              mode: 0o600,
            });
            data.options.reference_id = reference;
          }
          const voiceProbe = validate(modelById(data.model), {
            ...data.options,
            text:
              data.model === "moss-ttsd"
                ? "[S1] Voice validation."
                : "Voice validation.",
          });
          if (["moss-ttsd", "fireredtts2"].includes(data.model)) {
            const refs = voiceProbe.references as
              | { speaker: number }[]
              | undefined;
            voiceProbe.text = `[S${refs?.[0]?.speaker ?? 1}] Voice validation.`;
          }
          resolveInput(data.model, voiceProbe);
          const voice: Voice = {
            ...data,
            id: randomUUID(),
            created: new Date().toISOString(),
          };
          writeFileSync(
            join(home, "voices", voice.id + ".json"),
            JSON.stringify(voice),
            { mode: 0o600, flag: "wx" },
          );
          return json(res, 201, voice);
        }
        if (method === "GET" && parts.length === 2)
          return json(res, 200, {
            voices: readdirSync(join(home, "voices")).map((f) =>
              readVoice(f.slice(0, -5)),
            ),
          });
        if (parts[2]) {
          const voice = readVoice(parts[2]);
          if (method === "GET") return json(res, 200, voice);
          if (method === "DELETE") {
            if (grant.scope !== "admin")
              throw new ApiError(403, "Deletion requires admin");
            unlinkSync(join(home, "voices", voice.id + ".json"));
            return json(res, 200, { deleted: true });
          }
        }
      }
      throw new ApiError(404, "Unknown route; see tools/mac-tts/README.md");
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof z.ZodError)
        return json(res, 422, {
          error:
            "Unsupported or invalid options; GET /v1/capabilities for the exact model schema",
          issues: e.issues,
        });
      json(res, e instanceof ApiError ? e.status : 400, {
        error: e instanceof Error ? e.message : "Request failed",
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxConnections = 64;
  return { server, ctl };
}
async function waitJob(ctl: Controller, job: Job) {
  if (["succeeded", "failed", "cancelled"].includes(job.state)) return;
  await new Promise<void>((resolve) => {
    const listener = () => {
      if (["succeeded", "failed", "cancelled"].includes(job.state)) {
        ctl.off(job.id, listener);
        resolve();
      }
    };
    ctl.on(job.id, listener);
    listener();
  });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.umask(0o077);
  const home = process.env.MAC_TTS_HOME;
  if (!home) throw new Error("MAC_TTS_HOME required");
  const auth = JSON.parse(
    readFileSync(join(home, "auth.json"), "utf8"),
  ) as Auth;
  if (!auth.length || auth.some((a) => a.token.length < 32))
    throw new Error("Invalid private auth file");
  const { server, ctl } = makeServer(
    {
      home,
      worker: resolve(
        fileURLToPath(new URL("../../worker.py", import.meta.url)),
      ),
      python: join(home, "venv/bin/python"),
      qwenPython: join(home, "qwen-venv/bin/python"),
      queueLimit: 8,
      idleSeconds: Number(process.env.MAC_TTS_IDLE_SECONDS ?? 300),
      timeoutMs: 20 * 60 * 1000,
    },
    auth,
  );
  server.listen(
    Number(process.env.MAC_TTS_PORT ?? 8788),
    process.env.MAC_TTS_BIND ?? "127.0.0.1",
    () => console.log("Mac TTS controller ready"),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      server.close();
      void ctl.close().then(() => process.exit(0));
    });
}
