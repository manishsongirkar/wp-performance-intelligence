import { randomUUID } from "node:crypto";
import type { ReportRequest, ReportHooks } from "./report.js";

export type StepState = "queued" | "running" | "done" | "failed";
export interface JobStep { label: string; state: StepState; error?: string }
export interface Job {
  id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  createdAt: string;
  finishedAt?: string;
  title: string;
  steps: JobStep[];
  /** Folder name under the reports directory; the report URL is /reports/<folder>/report.html */
  folder?: string;
  filePath?: string;
  failures?: string[];
  error?: string;
}

type Runner = (req: ReportRequest, hooks: ReportHooks) => Promise<{ dir: string; file: string; folder: string; failures: string[]; stepCount: number }>;

/** In-memory, one job at a time (a browser run is heavy). Jobs are lost on restart; finished reports stay on disk. */
export function createJobManager(run: Runner, opts: { maxQueued?: number } = {}) {
  const jobs = new Map<string, Job>();
  const cancels = new Set<string>();
  const queue: Array<{ job: Job; req: ReportRequest }> = [];
  let busy = false;
  const maxQueued = opts.maxQueued ?? 10;

  async function pump(): Promise<void> {
    if (busy) return;
    const next = queue.shift();
    if (!next) return;
    busy = true;
    const { job, req } = next;
    job.status = "running";
    try {
      const out = await run(req, {
        onPlan: (labels) => { job.steps = labels.map((label) => ({ label, state: "queued" as StepState })); },
        onStep: (i, state, error) => { const s = job.steps[i]; if (s) { s.state = state; if (error) s.error = error; } },
        shouldCancel: () => cancels.has(job.id)
      });
      job.folder = out.folder; job.filePath = out.file; job.failures = out.failures;
      // A report where every check failed is not a success, even though the (failure-only) report file exists.
      const allFailed = out.stepCount > 0 && out.failures.length >= out.stepCount;
      job.status = allFailed ? "failed" : "done";
      if (allFailed) job.error = `Every check failed: ${out.failures[0] ?? "see the report's Failures section"}`;
    } catch (e) {
      job.status = cancels.has(job.id) ? "cancelled" : "failed";
      job.error = cancels.has(job.id) ? "Cancelled before finishing; no report was written." : e instanceof Error ? e.message : "Report failed.";
    } finally {
      job.finishedAt = new Date().toISOString();
      cancels.delete(job.id);
      for (const old of [...jobs.keys()].slice(0, Math.max(0, jobs.size - 50))) jobs.delete(old);   // bounded history
      busy = false;
      void pump();
    }
  }

  return {
    /** Returns undefined when the queue is full. */
    submit(req: ReportRequest, title: string): Job | undefined {
      if (queue.length >= maxQueued) return undefined;
      const job: Job = { id: randomUUID(), status: "queued", createdAt: new Date().toISOString(), title, steps: [] };
      jobs.set(job.id, job);
      queue.push({ job, req });
      void pump();
      return job;
    },
    get: (id: string) => jobs.get(id),
    list: () => [...jobs.values()].reverse(),
    cancel(id: string): boolean {
      const j = jobs.get(id);
      if (!j || (j.status !== "queued" && j.status !== "running")) return false;
      cancels.add(id);
      const q = queue.findIndex((x) => x.job.id === id);
      if (q >= 0) { queue.splice(q, 1); j.status = "cancelled"; j.finishedAt = new Date().toISOString(); j.error = "Cancelled before it started."; }
      return true;
    }
  };
}
export type JobManager = ReturnType<typeof createJobManager>;
