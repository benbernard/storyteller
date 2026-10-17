import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { modelById, type Input, type Model } from "./catalog.js";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Event = Record<string, unknown>;
export type Job = {
  id: string;
  kind: "load" | "inference";
  model: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  created: string;
  started?: string;
  finished?: string;
  result?: unknown;
  error?: string;
  events: Event[];
  input?: Input;
  cancelRequested?: boolean;
};
type Pending = {
  resolve: (r: unknown) => void;
  reject: (e: Error) => void;
  chunk: (e: Event) => void;
  timer: NodeJS.Timeout;
};
export type Config = {
  home: string;
  worker: string;
  python: string;
  qwenPython: string;
  textPython?: string;
  queueLimit: number;
  idleSeconds: number;
  timeoutMs: number;
  workerArgs?: string[];
};
export class Controller extends EventEmitter {
  jobs = new Map<string, Job>();
  queue: Job[] = [];
  active: Job | undefined;
  loaded: string | undefined;
  child: ChildProcessWithoutNullStreams | undefined;
  pending = new Map<string, Pending>();
  busy = false;
  stopping: Promise<void> | undefined;
  lastUsed = Date.now();
  timer: NodeJS.Timeout;
  constructor(public config: Config) {
    super();
    this.timer = setInterval(() => {
      if (
        !this.busy &&
        !this.stopping &&
        this.loaded &&
        Date.now() - this.lastUsed > config.idleSeconds * 1000
      )
        void this.stop();
    }, 1000);
    this.timer.unref();
  }
  status() {
    return {
      loaded: this.loaded ?? null,
      worker_pid: this.child?.pid ?? null,
      active: this.active?.id ?? null,
      queued: this.queue.length,
      stopping: !!this.stopping,
      idle_seconds: this.config.idleSeconds,
    };
  }
  event(job: Job, data: Event) {
    const e = {
      sequence: job.events.length,
      time: new Date().toISOString(),
      ...data,
    };
    job.events.push(e);
    this.emit(job.id, e);
  }
  enqueue(kind: Job["kind"], model: string, input?: Input) {
    modelById(model);
    if (this.stopping)
      throw new ApiError(
        409,
        "Worker is stopping; retry after status.stopping is false",
      );
    if (this.queue.length >= this.config.queueLimit)
      throw new ApiError(429, "GPU queue is full");
    if (this.jobs.size >= 256) {
      for (const [id, j] of this.jobs) {
        if (["succeeded", "failed", "cancelled"].includes(j.state))
          this.jobs.delete(id);
        if (this.jobs.size < 200) break;
      }
      if (this.jobs.size >= 256) throw new ApiError(429, "Job registry full");
    }
    const job: Job = {
      id: randomUUID(),
      kind,
      model,
      state: "queued",
      created: new Date().toISOString(),
      events: [],
      ...(input ? { input } : {}),
    };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.event(job, { event: "queued" });
    void this.pump();
    return job;
  }
  view(job: Job) {
    const { input, events, cancelRequested, ...publicJob } = job;
    return { ...publicJob, chunks: events.filter((x) => x.event === "chunk") };
  }
  get(id: string) {
    const j = this.jobs.get(id);
    if (!j)
      throw new ApiError(
        404,
        "Job not found (in-memory job records expire on restart or after 256 jobs)",
      );
    return j;
  }
  async pump() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      while (this.queue.length && !this.stopping) {
        const job = this.queue.shift()!;
        if (job.state === "cancelled") continue;
        this.active = job;
        job.state = "running";
        job.started = new Date().toISOString();
        this.event(job, { event: "running" });
        try {
          const model = modelById(job.model);
          if (job.kind === "load") job.result = await this.load(model);
          else {
            if (this.loaded !== job.model)
              throw new ApiError(
                409,
                `Load ${job.model} first; current model is ${this.loaded ?? "none"}`,
              );
            job.result = await this.rpc(
              { op: "generate", job_id: job.id, input: job.input },
              (e) => this.event(job, e),
            );
          }
          job.state = job.cancelRequested ? "cancelled" : "succeeded";
        } catch (e) {
          if (!(e instanceof ApiError)) await this.kill();
          job.state = job.cancelRequested ? "cancelled" : "failed";
          if (!job.cancelRequested)
            job.error = e instanceof Error ? e.message : "Worker failed";
        }
        job.finished = new Date().toISOString();
        delete job.input;
        this.event(job, {
          event: job.state,
          result: job.result,
          error: job.error,
        });
        this.lastUsed = Date.now();
        this.active = undefined;
      }
    } finally {
      this.busy = false;
    }
  }
  async load(model: Model) {
    if (this.loaded === model.id && this.child)
      return { loaded: model.id, reused: true };
    await this.kill();
    // A priority stop can arrive while the old process is exiting.
    if (this.stopping || this.active?.cancelRequested)
      throw new Error("Load cancelled");
    const python =
      model.runtime === "text"
        ? (this.config.textPython ?? join(this.config.home, "text-venv/bin/python"))
        : model.runtime === "firered"
        ? join(this.config.home, "firered-venv/bin/python")
        : model.runtime === "fish"
          ? join(this.config.home, "fish-venv/bin/python")
          : model.runtime === "mlx"
            ? this.config.python
            : this.config.qwenPython;
    const child = spawn(
      python,
      [this.config.worker, ...(this.config.workerArgs ?? [])],
      {
        env: {
          ...process.env,
          MAC_TTS_HOME: this.config.home,
          HF_HOME: join(this.config.home, "cache/huggingface"),
          PYTHONUNBUFFERED: "1",
        },
        stdio: "pipe",
      },
    );
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const e = JSON.parse(line) as Event;
        const p = this.pending.get(String(e.id));
        if (!p) return;
        if (e.event === "chunk") p.chunk(e);
        else {
          clearTimeout(p.timer);
          this.pending.delete(String(e.id));
          if (e.event === "error") p.reject(new Error(String(e.error)));
          else p.resolve(e.result);
        }
      } catch {
        void this.kill();
      }
    });
    // Logs are private and bounded by the launchd installer/log rotation command.
    child.stderr.on("data", (chunk) => {
      appendFileSync(join(this.config.home, "worker.log"), chunk, {
        mode: 0o600,
      });
    });
    const failed = (error: Error) => {
      if (this.child === child) {
        this.child = undefined;
        this.loaded = undefined;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(error);
        }
        this.pending.clear();
      }
    };
    child.stdin.on("error", () => {
      void this.kill();
    });
    child.on("error", (e) => failed(e));
    child.on("exit", (code, signal) =>
      failed(new Error(`Worker exited (${code ?? signal})`)),
    );
    const result = await this.rpc(
      {
        op: "load",
        model: {
          id: model.id,
          repo: model.repo,
          runtime: model.runtime,
          mode: model.mode,
        },
      },
      () => {},
    );
    if (this.stopping || this.active?.cancelRequested)
      throw new Error("Load cancelled");
    this.loaded = model.id;
    return result;
  }
  rpc(payload: Event, chunk: Pending["chunk"]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      if (!this.child) {
        reject(new Error("Worker unavailable"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Worker operation timed out"));
        void this.kill();
      }, this.config.timeoutMs);
      this.pending.set(id, { resolve, reject, chunk, timer });
      this.child.stdin.write(JSON.stringify({ id, ...payload }) + "\n", (e) => {
        if (e) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(e);
        }
      });
    });
  }
  async kill() {
    const child = this.child;
    this.loaded = undefined;
    if (!child) return;
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => child.kill("SIGKILL"), 2000);
      const done = () => {
        clearTimeout(timeout);
        resolve();
      };
      child.once("exit", done);
      child.once("close", done);
      child.kill("SIGTERM");
    });
    if (this.child === child) this.child = undefined;
  }
  async cancel(id: string) {
    const j = this.get(id);
    if (["succeeded", "failed", "cancelled"].includes(j.state))
      return this.view(j);
    if (this.active === j) {
      j.cancelRequested = true;
      this.event(j, { event: "cancelling" });
      await this.kill();
      while (this.active === j) await new Promise((r) => setTimeout(r, 10));
    } else {
      j.state = "cancelled";
      j.finished = new Date().toISOString();
      delete j.input;
      this.queue = this.queue.filter((x) => x !== j);
      this.event(j, { event: "cancelled" });
    }
    return this.view(j);
  }
  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      for (const job of this.queue) {
        job.state = "cancelled";
        job.finished = new Date().toISOString();
        delete job.input;
        this.event(job, { event: "cancelled" });
      }
      this.queue = [];
      if (this.active) {
        this.active.cancelRequested = true;
        this.event(this.active, { event: "cancelling" });
      }
      await this.kill();
      while (this.busy) await new Promise((r) => setTimeout(r, 10));
    })();
    try {
      await this.stopping;
    } finally {
      this.stopping = undefined;
    }
  }
  async close() {
    clearInterval(this.timer);
    await this.stop();
  }
}
