import { elapsed } from './log';
import type { Job, JobQueue, Phase, Progress, Scope } from './platform';
import { resumeWaiting, runJob } from './service';
import type { SqlStore } from './sql-store';

/**
 * The desktop's job queue: analyses and renders one at a time, in memory. OCR
 * and the model both want the whole machine, and an 8 GB laptop can't hold
 * both at once. The web uses Cloudflare Queues instead (web/worker).
 */
export class Jobs implements JobQueue, Progress {
  private queue: Job[] = [];
  private running: Promise<void> | null = null;
  readonly phases = new Map<string, Phase>();

  /** `after`: called when each job ends, with its error if it failed (a host that chains jobs or retries). */
  constructor(
    private scope: () => Scope,
    private after?: (job: Job, err?: unknown) => void | Promise<void>,
  ) {}

  async enqueue(job: Job): Promise<void> {
    if (!this.queue.some((j) => j.docId === job.docId && j.kind === job.kind)) this.queue.push(job);
    this.running ??= this.pump().finally(() => (this.running = null));
  }

  async set(docId: string, phase: Phase | null): Promise<void> {
    if (phase) this.phases.set(docId, phase);
    else this.phases.delete(docId);
  }

  get(doc: { id: string }): Phase | null {
    return this.phases.get(doc.id) ?? null;
  }

  /** A job running or queued, for the page's heartbeat. */
  get busy(): boolean {
    return this.running !== null;
  }

  /** Resolves when nothing is queued or running (tests, and locking). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async pump(): Promise<void> {
    for (let job = this.queue.shift(); job; job = this.queue.shift()) {
      const s = this.scope();
      const t = Date.now();
      const what = `${job.docId} ${job.kind}`;
      s.log('info', 'job', `${what} started${this.queue.length ? `, ${this.queue.length} more queued` : ''}`);
      try {
        await runJob(s, job);
        s.log('info', 'job', `${what} finished in ${elapsed(t)}`);
        await this.afterJob(job);
      } catch (err) {
        s.log('error', 'job', `${what} failed after ${elapsed(t)}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
        await this.afterJob(job, err);
      }
    }
  }

  private async afterJob(job: Job, err?: unknown): Promise<void> {
    try {
      await this.after?.(job, err);
    } catch (e) {
      this.scope().log('error', 'job', `${job.docId} after ${job.kind}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * After unlock: jobs the app was running when it quit start over, renders
   * cut short go back to review, and waiting documents get another try.
   */
  async recover(store: SqlStore): Promise<void> {
    const s = this.scope();
    const r = await store.recoverInterrupted();
    if (r.queue.length || r.renders) s.log('info', 'job', `recovery: ${r.cut} analyses cut short, ${r.renders} renders cut short, ${r.queue.length} documents queued`);
    for (const d of r.queue) await this.enqueue({ docId: d.id, projectId: d.project_id, kind: 'analyze' });
  }

  /** Documents parked for the model, queued again (the model just became ready). */
  resumeWaiting(): Promise<number> {
    return resumeWaiting(this.scope());
  }
}
