export class ServiceScheduler {
  constructor({ store, run, now = () => new Date(), intervalMs = 30_000 } = {}) {
    this.store = store;
    this.run = run;
    this.now = now;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const state = await this.store.read();
      const now = this.now();
      const due = (state.settings?.serviceSchedules ?? [])
        .filter((schedule) => schedule.enabled && Date.parse(schedule.nextRunAt) <= now.getTime())
        .sort((left, right) => Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt));
      for (const schedule of due) await this.#runOne(schedule, now);
    } finally {
      this.running = false;
    }
  }

  async #runOne(schedule, now) {
    const nextRunAt = new Date(now.getTime() + schedule.intervalMinutes * 60_000).toISOString();
    await this.store.updateServiceScheduleRuntime(schedule.id, {
      lastRunAt: now.toISOString(),
      nextRunAt,
      lastStatus: "running",
      lastError: null,
    });
    try {
      await this.run(schedule);
      await this.store.updateServiceScheduleRuntime(schedule.id, { lastStatus: "completed", lastError: null });
    } catch (error) {
      const busy = error?.code === "SCAN_ACTIVE";
      await this.store.updateServiceScheduleRuntime(schedule.id, {
        lastStatus: busy ? "skipped" : "failed",
        lastError: String(error?.message ?? error).slice(0, 500),
      });
    }
  }
}
