import { randomUUID } from "node:crypto";

export class ScanManager {
  constructor({ maxJobs = 20 } = {}) {
    this.jobs = new Map();
    this.maxJobs = maxJobs;
  }

  start(input, task) {
    if ([...this.jobs.values()].some((job) => ["queued", "running", "cancelling"].includes(job.status))) {
      const error = new Error("Another scan is already running");
      error.code = "SCAN_ACTIVE";
      throw error;
    }
    const controller = new AbortController();
    const job = {
      id: randomUUID(),
      status: "queued",
      input,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: { phase: "queued", completed: 0, total: 1, percent: 0, message: "Waiting", metrics: {} },
      resultSnapshotId: null,
      error: null,
      controller,
    };
    this.jobs.set(job.id, job);
    this.#trim();
    job.promise = Promise.resolve().then(async () => {
      job.status = "running";
      job.startedAt = new Date().toISOString();
      try {
        const result = await task({
          signal: controller.signal,
          onProgress: (progress) => this.#progress(job, progress),
        });
        if (controller.signal.aborted) throw abortError();
        job.status = "completed";
        job.resultSnapshotId = result?.id ?? null;
        job.progress = { ...job.progress, completed: job.progress.total, percent: 100, message: "Complete" };
        return result;
      } catch (error) {
        if (controller.signal.aborted || error?.name === "AbortError") {
          job.status = "cancelled";
          job.error = null;
        } else {
          job.status = "failed";
          job.error = safeMessage(error);
        }
        return null;
      } finally {
        job.finishedAt = new Date().toISOString();
      }
    });
    return publicJob(job);
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? publicJob(job) : null;
  }

  async wait(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    const result = await job.promise;
    return { job: publicJob(job), result };
  }

  active() {
    const job = [...this.jobs.values()].find((item) => ["queued", "running", "cancelling"].includes(item.status));
    return job ? publicJob(job) : null;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (["queued", "running"].includes(job.status)) {
      job.status = "cancelling";
      job.progress.message = "Cancelling";
      job.controller.abort();
    }
    return publicJob(job);
  }

  #progress(job, progress) {
    if (!["running", "cancelling"].includes(job.status)) return;
    const total = Math.max(0, Number(progress.total) || 0);
    const completed = Math.max(0, Math.min(total || Infinity, Number(progress.completed) || 0));
    job.progress = {
      phase: String(progress.phase ?? "running").slice(0, 80),
      completed,
      total,
      percent: total ? Math.round((completed / total) * 100) : 0,
      message: String(progress.message ?? "").slice(0, 160),
      metrics: safeMetrics(progress.metrics),
    };
  }

  #trim() {
    const finished = [...this.jobs.values()].filter((job) => !["queued", "running", "cancelling"].includes(job.status));
    while (this.jobs.size > this.maxJobs && finished.length) this.jobs.delete(finished.shift().id);
  }
}

function safeMetrics(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries(Object.entries(input).slice(0, 12).flatMap(([key, value]) => {
    const safeKey = String(key).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
    const number = Number(value);
    return safeKey && Number.isFinite(number) ? [[safeKey, Math.max(0, number)]] : [];
  }));
}

function publicJob(job) {
  const { controller, promise, ...result } = job;
  return structuredClone(result);
}

function abortError() {
  const error = new Error("Scan cancelled");
  error.name = "AbortError";
  return error;
}

function safeMessage(error) {
  return String(error?.message ?? error).slice(0, 500);
}
