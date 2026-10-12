import { describe, expect, it } from "vitest";
import { createJobManager } from "../apps/api/src/jobs.js";
import type { ReportRequest } from "../apps/api/src/report.js";

const req: ReportRequest = { audits: ["https://a.test/"], compares: [], measures: [], lighthouse: [], runs: 1, profiles: ["desktop"], outDir: "/tmp" };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => boolean) => { for (let i = 0; i < 200 && !fn(); i++) await tick(); expect(fn()).toBe(true); };

describe("job manager", () => {
  it("runs jobs one at a time, in order, with step progress", async () => {
    const order: string[] = []; let release!: () => void; const gate = new Promise<void>((r) => (release = r));
    const m = createJobManager(async (r, hooks) => {
      order.push(`start ${r.audits[0]}`); hooks.onPlan?.(["audit x", "audit y"]); hooks.onStep?.(0, "running");
      if (r.audits[0] === "https://first.test/") await gate;
      hooks.onStep?.(0, "done"); hooks.onStep?.(1, "failed", "boom"); order.push(`end ${r.audits[0]}`);
      return { dir: "/d", file: "/d/report.html", folder: "f_2026-01-01_00-00-00", failures: ["audit y: boom"], stepCount: 2 };
    });
    const a = m.submit({ ...req, audits: ["https://first.test/"] }, "first")!, b = m.submit({ ...req, audits: ["https://second.test/"] }, "second")!;
    await waitFor(() => a.status === "running" && a.steps.length === 2);
    expect(b.status).toBe("queued"); expect(order).toEqual(["start https://first.test/"]);
    expect(a.steps.map((s) => s.state)).toEqual(["running", "queued"]);
    release();
    await waitFor(() => b.status === "done");
    expect(order).toEqual(["start https://first.test/", "end https://first.test/", "start https://second.test/", "end https://second.test/"]);
    expect(a).toMatchObject({ status: "done", folder: "f_2026-01-01_00-00-00", failures: ["audit y: boom"] });
    expect(a.steps[1]).toMatchObject({ state: "failed", error: "boom" });
    expect(m.list().map((j) => j.title)).toEqual(["second", "first"]);
  });
  it("marks a thrown error as failed and keeps going", async () => {
    let n = 0; const m = createJobManager(async () => { if (n++ === 0) throw new Error("baseline missing"); return { dir: "", file: "", folder: "ok_2026-01-01_00-00-00", failures: [], stepCount: 1 }; });
    const a = m.submit(req, "a")!, b = m.submit(req, "b")!;
    await waitFor(() => b.status === "done");
    expect(a).toMatchObject({ status: "failed", error: "baseline missing" });
  });
  it("cancels a queued job immediately and a running one at the next step", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => (release = r)); let cancelled = false;
    const m = createJobManager(async (_r, hooks) => { await gate; cancelled = !!hooks.shouldCancel?.(); if (cancelled) throw new Error("Cancelled."); return { dir: "", file: "", folder: "", failures: [], stepCount: 1 }; });
    const run = m.submit(req, "run")!, queued = m.submit(req, "queued")!;
    await waitFor(() => run.status === "running");
    expect(m.cancel(queued.id)).toBe(true); expect(queued.status).toBe("cancelled");
    expect(m.cancel(run.id)).toBe(true); release();
    await waitFor(() => run.status === "cancelled");
    expect(m.cancel(run.id)).toBe(false); expect(m.cancel("nope")).toBe(false);
  });
  it("rejects submissions beyond the queue limit", () => {
    const m = createJobManager(() => new Promise(() => {}), { maxQueued: 1 });
    m.submit(req, "running"); m.submit(req, "queued");
    expect(m.submit(req, "too many")).toBeUndefined();
  });
});

describe("job outcomes", () => {
  const ok = { dir: "", file: "/d/report.html", folder: "f_2026-01-01_00-00-00" };
  it("a report where every check failed is a failed job (the report is still reachable)", async () => {
    const m = createJobManager(async () => ({ ...ok, failures: ["audit x: boom", "lighthouse y: boom"], stepCount: 2 }));
    const j = m.submit(req, "x")!;
    await waitFor(() => j.status !== "queued" && j.status !== "running");
    expect(j).toMatchObject({ status: "failed", folder: ok.folder }); expect(j.error).toContain("Every check failed: audit x: boom");
  });
  it("partial failure stays done", async () => {
    const m = createJobManager(async () => ({ ...ok, failures: ["audit x: boom"], stepCount: 2 }));
    const j = m.submit(req, "x")!; await waitFor(() => j.status === "done"); expect(j.failures).toHaveLength(1);
  });
  it("keeps only the latest 50 jobs", async () => {
    const m = createJobManager(async () => ({ ...ok, failures: [], stepCount: 1 }), { maxQueued: 100 });
    for (let i = 0; i < 60; i++) m.submit(req, `j${i}`);
    await waitFor(() => m.list().length > 0 && m.list().every((j) => j.status === "done" || j.status === "queued") && m.list()[0]!.title === "j59" && m.list()[0]!.status === "done");
    expect(m.list().length).toBeLessThanOrEqual(51);
  });
});
