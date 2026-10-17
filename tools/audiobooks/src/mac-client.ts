import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { Store } from './store.js';
export class MacUnavailable extends Error {}
const credentialSchema = z.object({ endpoint: z.url(), token: z.string().min(32) });
type Job = { id: string; state: string; error?: string; result?: { text?: string } };
export class MacClient {
  private endpoint = ''; private token = '';
  constructor(readonly credential: string, readonly lease: string) {}
  async initialize() { const saved = credentialSchema.parse(JSON.parse(await readFile(this.credential, 'utf8'))); this.endpoint = saved.endpoint; this.token = saved.token; }
  async call<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
    let response: Response;
    try { response = await fetch(this.endpoint + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'X-Worker-Lease': this.lease }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000), redirect: 'error' }); }
    catch { throw new MacUnavailable('Waiting for the Mac audio worker to come online'); }
    if (!response.ok) {
      if ([409, 429, 502, 503, 504].includes(response.status)) throw new MacUnavailable('Waiting for the Mac audio worker to finish its current job');
      if (response.status === 404) throw new Error('Mac API item not found');
      throw new Error(`Mac worker rejected a request (${response.status})`);
    }
    return await response.json() as T;
  }
  async claim() { return this.call('/v1/lease', { owner: this.lease, seconds: 180 }); }
  async release() { await this.call('/v1/lease/release', { owner: this.lease }); }
  async wait(job: Job, cancelled: () => boolean = () => false) {
    const deadline = Date.now() + 20 * 60000;
    while (['running', 'queued'].includes(job.state)) {
      if (cancelled()) { await this.call(`/v1/jobs/${job.id}/cancel`, {}); throw new Error('Job cancelled'); }
      if (Date.now() > deadline) throw new MacUnavailable('Mac job is still running; its saved job ID will be checked again');
      await new Promise(resolve => setTimeout(resolve, 1000)); job = await this.call<Job>(`/v1/jobs/${job.id}`);
    }
    if (job.state !== 'succeeded') throw new Error(`Local inference failed: ${job.error ?? job.state}`); return job;
  }
  async switch(model: string, cancelled: () => boolean = () => false) { await this.wait(await this.call<Job>('/v1/switch', { model }), cancelled); }
  async text(input: Record<string, unknown>, state: Store, attempt: string, cancelled: () => boolean) {
    const saved = await state.read<{ job: Job }>(`${attempt}/pending.json`);
    let job: Job | undefined;
    if (saved) {
      try { job = await this.call<Job>(`/v1/jobs/${saved.job.id}`); }
      catch (error) { if ((error as Error).message !== 'Mac API item not found') throw error; await state.object('expired-mac-jobs', saved); }
      if (job && ['failed', 'cancelled'].includes(job.state)) { await state.object('failed-mac-jobs', job); job = undefined; }
    }
    if (!job) { job = await this.call<Job>('/v1/jobs', { model: 'qwen-text', input }); await state.write(`${attempt}/pending.json`, { job }); }
    const complete = await this.wait(job, cancelled); await state.write(`${attempt}/result.json`, complete);
    if (typeof complete.result?.text !== 'string') throw new Error('Local text model returned no text'); return complete.result.text;
  }
}
