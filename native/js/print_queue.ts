/*
 * Print job queue of libniimblue.
 *
 * niimbluelib serializes single packets, not whole print jobs: two print tasks
 * running at the same time interleave their packets and both fail. Every print
 * (niim_print, niim_print_batch, niim_print_template) is therefore a job in a
 * FIFO queue and a runner executes one job at a time.
 */

export type JobState = "queued" | "printing" | "done" | "failed" | "cancelled";

/** Public job description (no image data). */
export interface JobSnapshot {
  id: number;
  state: JobState;
  label?: string;
  /** Number of different pages (images / template labels) in the job */
  pages: number;
  /** Pages including copies */
  totalPages: number;
  /** Unix time in milliseconds */
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  result?: unknown;
}

interface Job extends JobSnapshot {
  /** Executes the job, dropped when the job finishes (releases image data). */
  run?: () => Promise<unknown>;
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** How many finished jobs listJobs / getJob remember. */
const HISTORY_LIMIT = 100;

const snapshot = (j: Job): JobSnapshot => {
  const s: JobSnapshot = {
    id: j.id,
    state: j.state,
    pages: j.pages,
    totalPages: j.totalPages,
    createdAt: j.createdAt,
  };
  if (j.label !== undefined) s.label = j.label;
  if (j.startedAt !== undefined) s.startedAt = j.startedAt;
  if (j.finishedAt !== undefined) s.finishedAt = j.finishedAt;
  if (j.error !== undefined) s.error = j.error;
  if (j.result !== undefined) s.result = j.result;
  return s;
};

const isFinished = (s: JobState) => s === "done" || s === "failed" || s === "cancelled";

export class PrintQueue {
  private nextId = 1;
  private queue: Job[] = [];
  private current?: Job;
  private history: Job[] = [];
  private paused = false;

  /** @param emit forwards queue events (jobqueued, jobstarted, jobdone) to the host */
  constructor(private readonly emit: (name: string, payload: unknown) => void) {}

  /** Id of the printing job, used to tag print progress events. */
  get currentJobId(): number | undefined {
    return this.current?.id;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Add a job. `run` executes it when its turn comes; its return value becomes the job result.
   * Returns the job snapshot and a promise settled when the job finishes.
   */
  submit(
    run: () => Promise<unknown>,
    info: { label?: string; pages: number; totalPages: number },
  ): { job: JobSnapshot; done: Promise<unknown> } {
    let resolve!: (v: unknown) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Nobody may wait for a "wait": false job; avoid unhandled rejection reports.
    promise.catch(() => {});

    const job: Job = {
      id: this.nextId++,
      state: "queued",
      label: info.label,
      pages: info.pages,
      totalPages: info.totalPages,
      createdAt: Date.now(),
      run,
      promise,
      resolve,
      reject,
    };

    this.queue.push(job);
    this.emit("jobqueued", snapshot(job));
    this.pump();
    return { job: snapshot(job), done: promise };
  }

  private find(id: number): Job | undefined {
    if (this.current?.id === id) return this.current;
    return this.queue.find((j) => j.id === id) ?? this.history.find((j) => j.id === id);
  }

  private require(id: unknown): Job {
    const n = Number(id);
    const job = Number.isFinite(n) ? this.find(n) : undefined;
    if (job === undefined) {
      throw new Error(`job ${String(id)} not found`);
    }
    return job;
  }

  get(id: unknown): JobSnapshot {
    return snapshot(this.require(id));
  }

  /** Active jobs (printing first, then queued in order) and the last finished ones (oldest first). */
  list(): JobSnapshot[] {
    const active = this.current ? [this.current, ...this.queue] : [...this.queue];
    return [...this.history, ...active].map(snapshot);
  }

  /** Resolves with the snapshot when the job is done, throws the job error if it failed or was cancelled. */
  async wait(id: unknown): Promise<JobSnapshot> {
    const job = this.require(id);
    if (!isFinished(job.state)) {
      try {
        await job.promise;
      } catch {
        /* reported below */
      }
    }
    if (job.state !== "done") {
      throw new Error(job.error ?? `job ${job.id} ${job.state}`);
    }
    return snapshot(job);
  }

  /** Cancel a queued job. A printing or finished job can't be cancelled. */
  cancel(id: unknown): JobSnapshot {
    const job = this.require(id);
    if (job.state === "printing") {
      throw new Error(`job ${job.id} is printing and cannot be cancelled`);
    }
    if (job.state !== "queued") {
      throw new Error(`job ${job.id} already finished (${job.state})`);
    }
    this.queue = this.queue.filter((j) => j !== job);
    this.finish(job, "cancelled", undefined, `job ${job.id} cancelled`);
    return snapshot(job);
  }

  /** Cancel all queued jobs. Returns how many were cancelled. */
  clear(): number {
    return this.failQueued("cancelled");
  }

  /**
   * Fail (or cancel) every queued job. The printing job is not touched.
   * @param reason "cancelled" or an error message (state becomes "failed")
   */
  failQueued(reason: "cancelled" | string): number {
    const jobs = this.queue;
    this.queue = [];
    for (const job of jobs) {
      if (reason === "cancelled") {
        this.finish(job, "cancelled", undefined, `job ${job.id} cancelled`);
      } else {
        this.finish(job, "failed", undefined, reason);
      }
    }
    return jobs.length;
  }

  /** The printing job finishes, no new job starts until resume. */
  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.pump();
  }

  private finish(job: Job, state: "done" | "failed" | "cancelled", result: unknown, error?: string) {
    job.state = state;
    job.finishedAt = Date.now();
    job.run = undefined; // release image data
    if (state === "done") {
      job.result = result;
    } else {
      job.error = error;
    }

    this.history.push(job);
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }

    const ev: { id: number; state: JobState; error?: string; result?: unknown } = { id: job.id, state };
    if (job.error !== undefined) ev.error = job.error;
    if (job.result !== undefined) ev.result = job.result;
    this.emit("jobdone", ev);

    if (state === "done") {
      job.resolve(result);
    } else {
      job.reject(new Error(error ?? `job ${job.id} ${state}`));
    }
  }

  private pump() {
    if (this.current !== undefined || this.paused) {
      return;
    }
    const job = this.queue.shift();
    if (job === undefined) {
      return;
    }

    this.current = job;
    job.state = "printing";
    job.startedAt = Date.now();
    this.emit("jobstarted", snapshot(job));

    const run = job.run!;
    void (async () => {
      let ok = false;
      let result: unknown;
      let error: string | undefined;
      try {
        result = await run();
        ok = true;
      } catch (e) {
        error = e instanceof Error ? e.message || String(e) : String(e);
      }
      this.current = undefined;
      if (ok) {
        this.finish(job, "done", result);
      } else {
        this.finish(job, "failed", undefined, error);
      }
      this.pump();
    })();
  }
}
