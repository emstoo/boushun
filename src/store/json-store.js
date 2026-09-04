import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_OVERRIDES = Object.freeze({ devices: {}, merges: [], splits: [], audit: [] });
const EMPTY_STATE = Object.freeze({ version: 2, snapshots: [], layout: {}, overrides: EMPTY_OVERRIDES, settings: { interfaces: {}, serviceSchedules: [] }, notifications: [] });
const DATABASE_FORMAT = "boushun-database";
const LEGACY_DATABASE_FORMATS = new Set(["lantern-database"]);
const DATABASE_SCHEMA_VERSION = 2;
const MAX_DATABASE_BACKUPS = 5;
const DEFAULT_FILE_SYSTEM = { chmod, mkdir, readFile, readdir, rename, unlink, writeFile };

export class JsonStore {
  constructor(dataDirectory, { maxSnapshots = 50, fileSystem = {} } = {}) {
    this.dataDirectory = dataDirectory;
    this.statePath = path.join(dataDirectory, "state.json");
    this.maxSnapshots = maxSnapshots;
    this.fileSystem = { ...DEFAULT_FILE_SYSTEM, ...fileSystem };
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await this.fileSystem.mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    await this.fileSystem.chmod(this.dataDirectory, 0o700);
    try {
      await this.fileSystem.readFile(this.statePath, "utf8");
      await this.fileSystem.chmod(this.statePath, 0o600);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.#write(freshState());
    }
  }

  async read() {
    await this.writeQueue;
    try {
      const state = JSON.parse(await this.fileSystem.readFile(this.statePath, "utf8"));
      return normalizeState(state);
    } catch (error) {
      if (error.code === "ENOENT") return freshState();
      throw error;
    }
  }

  async latest() {
    const state = await this.read();
    return state.snapshots.at(-1) ?? null;
  }

  async databaseSummary() {
    return summarizeDatabase(await this.read());
  }

  async exportDatabase() {
    const state = await this.read();
    return {
      format: DATABASE_FORMAT,
      schemaVersion: DATABASE_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      state,
    };
  }

  async previewDatabaseImport(input) {
    await this.writeQueue;
    const state = validateDatabaseImport(input, this.maxSnapshots);
    return summarizeDatabase(state);
  }

  async importDatabase(input) {
    return this.#enqueue(async () => {
      const imported = validateDatabaseImport(input, this.maxSnapshots);
      const current = await this.#readUnqueued();
      const backup = await this.#backup(current, "import");
      await this.#write(imported);
      return { summary: summarizeDatabase(imported), backup };
    });
  }

  async resetDatabase() {
    return this.#enqueue(async () => {
      const current = await this.#readUnqueued();
      const backup = await this.#backup(current, "reset");
      const state = freshState();
      await this.#write(state);
      return { summary: summarizeDatabase(state), backup };
    });
  }

  async saveSnapshot(snapshot) {
    return this.#enqueue(async () => {
      const state = await this.#readUnqueued();
      state.snapshots.push(snapshot);
      state.snapshots = state.snapshots.slice(-this.maxSnapshots);
      await this.#write(state);
      return snapshot;
    });
  }

  async saveLayout(layout) {
    return this.#enqueue(async () => {
      const state = await this.#readUnqueued();
      state.layout = sanitizeLayout(layout);
      await this.#write(state);
      return state.layout;
    });
  }

  async saveDeviceOverride(id, patch, actor = "local-user") {
    return this.#enqueue(async () => {
      const state = await this.#readUnqueued();
      const before = state.overrides.devices[id] ?? null;
      const after = sanitizeDeviceOverride({ ...(before ?? {}), ...patch });
      state.overrides.devices[id] = after;
      appendAudit(state, actor, "device.override", { id, before, after });
      await this.#write(state);
      return { override: after, audit: state.overrides.audit.at(-1) };
    });
  }

  async saveInterfacePolicy(name, patch, actor = "local-user") {
    return this.#enqueue(async () => {
      if (typeof name !== "string" || !name.trim() || name.length > 120) throw badRequest("A valid interface name is required");
      const state = await this.#readUnqueued();
      const before = state.settings.interfaces[name] ?? null;
      const after = sanitizeInterfacePolicy(patch);
      state.settings.interfaces[name] = after;
      appendAudit(state, actor, "interface.policy", { name, before, after });
      await this.#write(state);
      return { name, policy: after, audit: state.overrides.audit.at(-1) };
    });
  }

  async saveMerge(input, actor = "local-user") {
    return this.#enqueue(async () => {
      const state = await this.#readUnqueued();
      const merge = sanitizeMerge(input);
      state.overrides.merges.push(merge);
      appendAudit(state, actor, "device.merge", merge);
      await this.#write(state);
      return { merge, audit: state.overrides.audit.at(-1) };
    });
  }

  async saveSplit(input, actor = "local-user") {
    return this.#enqueue(async () => {
      const state = await this.#readUnqueued();
      const split = sanitizeSplit(input);
      state.overrides.splits.push(split);
      appendAudit(state, actor, "device.split", split);
      await this.#write(state);
      return { split, audit: state.overrides.audit.at(-1) };
    });
  }

  async saveSplitBatch(inputs, actor = "local-user") {
    return this.#enqueue(async () => {
      const state = await this.#readUnqueued();
      const splits = (Array.isArray(inputs) ? inputs : []).map(sanitizeSplit);
      if (!splits.length || splits.length > 253) throw badRequest("A split batch requires between 1 and 253 entries");
      state.overrides.splits.push(...splits);
      appendAudit(state, actor, "device.recommended-split", { splits });
      await this.#write(state);
      return { splits, audit: state.overrides.audit.at(-1) };
    });
  }

  async saveServiceSchedule(input, actor = "local-user") {
    return this.#enqueue(async () => {
      const state = await this.#readUnqueued();
      if (state.settings.serviceSchedules.length >= 10) throw badRequest("No more than 10 service schedules are allowed");
      const now = new Date().toISOString();
      const intervalMinutes = Number(input?.intervalMinutes);
      if (!Number.isInteger(intervalMinutes) || intervalMinutes < 15 || intervalMinutes > 10_080) {
        throw badRequest("Schedule interval must be between 15 and 10080 minutes");
      }
      const schedule = sanitizeServiceSchedule({
        ...input,
        id: `schedule:${crypto.randomUUID()}`,
        createdAt: now,
        updatedAt: now,
        nextRunAt: input?.nextRunAt ?? new Date(Date.parse(now) + intervalMinutes * 60_000).toISOString(),
      });
      state.settings.serviceSchedules.push(schedule);
      appendAudit(state, actor, "schedule.create", { schedule });
      await this.#write(state);
      return { schedule, audit: state.overrides.audit.at(-1) };
    });
  }

  async updateServiceSchedule(id, patch, actor = "local-user") {
    return this.#enqueue(async () => {
      const state = await this.#readUnqueued();
      const index = state.settings.serviceSchedules.findIndex((item) => item.id === id);
      if (index === -1) throw notFound("Schedule not found");
      const before = state.settings.serviceSchedules[index];
      const intervalChanged = patch?.intervalMinutes !== undefined && Number(patch.intervalMinutes) !== before.intervalMinutes;
      const now = new Date().toISOString();
      const after = sanitizeServiceSchedule({
        ...before,
        ...patch,
        id: before.id,
        createdAt: before.createdAt,
        updatedAt: now,
        nextRunAt: intervalChanged ? new Date(Date.parse(now) + Number(patch.intervalMinutes) * 60_000).toISOString() : before.nextRunAt,
      });
      state.settings.serviceSchedules[index] = after;
      appendAudit(state, actor, "schedule.update", { id, before, after });
      await this.#write(state);
      return { schedule: after, audit: state.overrides.audit.at(-1) };
    });
  }

  async updateServiceScheduleRuntime(id, patch) {
    return this.#enqueue(async () => {
      const state = await this.#readUnqueued();
      const schedule = state.settings.serviceSchedules.find((item) => item.id === id);
      if (!schedule) return null;
      for (const key of ["lastRunAt", "nextRunAt", "lastStatus", "lastError"]) {
        if (patch?.[key] !== undefined) schedule[key] = patch[key];
      }
      await this.#write(state);
      return schedule;
    });
  }

  async deleteServiceSchedule(id, actor = "local-user") {
    return this.#enqueue(async () => {
      const state = await this.#readUnqueued();
      const before = state.settings.serviceSchedules.find((item) => item.id === id);
      if (!before) throw notFound("Schedule not found");
      state.settings.serviceSchedules = state.settings.serviceSchedules.filter((item) => item.id !== id);
      appendAudit(state, actor, "schedule.delete", { schedule: before });
      await this.#write(state);
      return { deleted: id, audit: state.overrides.audit.at(-1) };
    });
  }

  async appendPortNotifications(input) {
    return this.#enqueue(async () => {
      const state = await this.#readUnqueued();
      const existing = new Set(state.notifications.map((item) => item.fingerprint));
      const added = [];
      for (const raw of Array.isArray(input) ? input : []) {
        const notification = sanitizeNotification(raw);
        if (existing.has(notification.fingerprint)) continue;
        existing.add(notification.fingerprint);
        state.notifications.push(notification);
        added.push(notification);
      }
      state.notifications = state.notifications.slice(-200);
      if (added.length) await this.#write(state);
      return added;
    });
  }

  async markNotificationsRead(ids = null) {
    return this.#enqueue(async () => {
      const state = await this.#readUnqueued();
      const selected = Array.isArray(ids) ? new Set(ids) : null;
      const at = new Date().toISOString();
      for (const item of state.notifications) {
        if (!item.readAt && (!selected || selected.has(item.id))) item.readAt = at;
      }
      await this.#write(state);
      return state.notifications;
    });
  }

  #enqueue(operation) {
    const pending = this.writeQueue.then(operation, operation);
    this.writeQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async #readUnqueued() {
    try {
      const parsed = JSON.parse(await this.fileSystem.readFile(this.statePath, "utf8"));
      return normalizeState(parsed);
    } catch (error) {
      if (error.code === "ENOENT") return freshState();
      throw error;
    }
  }

  async #write(state) {
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
    await this.fileSystem.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await this.fileSystem.rename(temporaryPath, this.statePath);
  }

  async #backup(state, operation) {
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const fileName = `state.backup.${timestamp}.${operation}.${crypto.randomUUID()}.json`;
    const backupPath = path.join(this.dataDirectory, fileName);
    const temporaryPath = `${backupPath}.${process.pid}.tmp`;
    await this.fileSystem.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await this.fileSystem.rename(temporaryPath, backupPath);
    const backups = (await this.fileSystem.readdir(this.dataDirectory))
      .filter((name) => /^state\.backup\..+\.(?:import|reset)\.[0-9a-f-]+\.json$/.test(name))
      .sort()
      .reverse();
    for (const expired of backups.slice(MAX_DATABASE_BACKUPS)) {
      await this.fileSystem.unlink(path.join(this.dataDirectory, expired));
    }
    return fileName;
  }
}

function validateDatabaseImport(input, maxSnapshots) {
  if (!isRecord(input)) throw badRequest("The database import must be a JSON object");
  let candidate = input;
  if (Object.hasOwn(input, "format")) {
    if (![DATABASE_FORMAT, ...LEGACY_DATABASE_FORMATS].includes(input.format) || input.schemaVersion !== DATABASE_SCHEMA_VERSION || !isRecord(input.state)) {
      throw badRequest("This is not a supported Boushun database export");
    }
    candidate = input.state;
  }
  if (![1, 2].includes(candidate.version)) throw badRequest("Database version must be 1 or 2");
  if (!Array.isArray(candidate.snapshots)) throw badRequest("Database snapshots must be an array");
  if (candidate.snapshots.length > maxSnapshots) throw badRequest(`Database contains more than ${maxSnapshots} snapshots`);
  for (const snapshot of candidate.snapshots) {
    if (!isRecord(snapshot) || !validId(snapshot.id)) throw badRequest("Every snapshot must have a valid id");
    if (validDate(snapshot.observedAt) === null) {
      throw badRequest(`Snapshot ${snapshot.id} has an invalid observedAt value`);
    }
    for (const key of ["devices", "interfaces", "routes", "resolver", "scanCandidates", "evidence", "explicitLinks", "sources", "warnings"]) {
      assertOptionalArray(snapshot, key, `Snapshot ${snapshot.id}`);
    }
    assertOptionalRecord(snapshot, "discovery", `Snapshot ${snapshot.id}`);
    for (const key of ["dhcp", "mdns", "ssdp"]) assertOptionalArray(snapshot.discovery, key, `Snapshot ${snapshot.id} discovery`);
    for (const key of ["tcpServices", "udpServices", "kubernetes", "snmp", "controller"]) {
      assertOptionalRecord(snapshot, key, `Snapshot ${snapshot.id}`);
    }
    for (const key of ["ports", "endpoints", "uncertainEndpoints"]) assertOptionalArray(snapshot.tcpServices, key, `Snapshot ${snapshot.id} TCP services`);
    for (const key of ["ports", "endpoints", "uncertainEndpoints"]) assertOptionalArray(snapshot.udpServices, key, `Snapshot ${snapshot.id} UDP services`);
    for (const key of ["nodes", "services"]) assertOptionalArray(snapshot.kubernetes, key, `Snapshot ${snapshot.id} Kubernetes data`);
    assertOptionalArray(snapshot.snmp, "observations", `Snapshot ${snapshot.id} SNMP data`);
    for (const key of ["devices", "links", "services"]) assertOptionalArray(snapshot.controller, key, `Snapshot ${snapshot.id} controller data`);
  }
  if (candidate.layout !== undefined && !isRecord(candidate.layout)) throw badRequest("Database layout must be an object");
  if (candidate.overrides !== undefined && !isRecord(candidate.overrides)) throw badRequest("Database overrides must be an object");
  if (candidate.settings !== undefined && !isRecord(candidate.settings)) throw badRequest("Database settings must be an object");
  if (candidate.notifications !== undefined && !Array.isArray(candidate.notifications)) throw badRequest("Database notifications must be an array");
  const overrides = candidate.overrides ?? {};
  if (overrides.devices !== undefined && !isRecord(overrides.devices)) throw badRequest("Device overrides must be an object");
  for (const key of ["merges", "splits", "audit"]) {
    if (overrides[key] !== undefined && !Array.isArray(overrides[key])) throw badRequest(`Override ${key} must be an array`);
  }
  const settings = candidate.settings ?? {};
  if (settings.interfaces !== undefined && !isRecord(settings.interfaces)) throw badRequest("Interface settings must be an object");
  if (settings.serviceSchedules !== undefined && !Array.isArray(settings.serviceSchedules)) throw badRequest("Service schedules must be an array");
  for (const schedule of settings.serviceSchedules ?? []) sanitizeServiceSchedule(schedule);
  for (const notification of candidate.notifications ?? []) sanitizeNotification(notification);

  const normalized = normalizeState(structuredClone(candidate));
  normalized.layout = sanitizeLayout(candidate.layout);
  return normalized;
}

function summarizeDatabase(state) {
  const observed = state.snapshots.map((snapshot) => validDate(snapshot.observedAt)).filter(Boolean).sort();
  return {
    schemaVersion: DATABASE_SCHEMA_VERSION,
    snapshots: state.snapshots.length,
    latestObservedAt: observed.at(-1) ?? null,
    deviceOverrides: Object.keys(state.overrides.devices).length,
    merges: state.overrides.merges.length,
    splits: state.overrides.splits.length,
    layoutPositions: Object.keys(state.layout).length,
    interfacePolicies: Object.keys(state.settings.interfaces).length,
    schedules: state.settings.serviceSchedules.length,
    notifications: state.notifications.length,
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertOptionalArray(owner, key, context) {
  if (owner?.[key] !== undefined && owner[key] !== null && !Array.isArray(owner[key])) {
    throw badRequest(`${context} ${key} must be an array`);
  }
}

function assertOptionalRecord(owner, key, context) {
  if (owner?.[key] !== undefined && owner[key] !== null && !isRecord(owner[key])) {
    throw badRequest(`${context} ${key} must be an object`);
  }
}

function normalizeState(state) {
  const overrides = state?.overrides && typeof state.overrides === "object" ? state.overrides : {};
  return {
    version: 2,
    snapshots: Array.isArray(state?.snapshots) ? state.snapshots : [],
    layout: state?.layout && typeof state.layout === "object" ? state.layout : {},
    overrides: {
      devices: overrides.devices && typeof overrides.devices === "object" ? overrides.devices : {},
      merges: Array.isArray(overrides.merges) ? overrides.merges : [],
      splits: Array.isArray(overrides.splits) ? overrides.splits : [],
      audit: Array.isArray(overrides.audit) ? overrides.audit.slice(-500) : [],
    },
    settings: {
      interfaces: state?.settings?.interfaces && typeof state.settings.interfaces === "object"
        ? state.settings.interfaces
        : {},
      serviceSchedules: Array.isArray(state?.settings?.serviceSchedules)
        ? state.settings.serviceSchedules.flatMap((item) => {
          try { return [sanitizeServiceSchedule(item)]; } catch { return []; }
        }).slice(0, 10)
        : [],
    },
    notifications: Array.isArray(state?.notifications)
      ? state.notifications.flatMap((item) => {
        try { return [sanitizeNotification(item)]; } catch { return []; }
      }).slice(-200)
      : [],
  };
}

function freshState() {
  return { version: 2, snapshots: [], layout: {}, overrides: { devices: {}, merges: [], splits: [], audit: [] }, settings: { interfaces: {}, serviceSchedules: [] }, notifications: [] };
}

function sanitizeServiceSchedule(input) {
  const protocol = input?.protocol === "udp" ? "udp" : input?.protocol === "tcp" ? "tcp" : null;
  const intervalMinutes = Number(input?.intervalMinutes);
  if (!validId(input?.id) || !protocol || typeof input?.cidr !== "string" || !input.cidr || typeof input?.preset !== "string") {
    throw badRequest("A schedule requires id, protocol, cidr, and preset");
  }
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 15 || intervalMinutes > 10_080) {
    throw badRequest("Schedule interval must be between 15 and 10080 minutes");
  }
  return {
    id: input.id,
    protocol,
    enabled: input.enabled !== false,
    cidr: input.cidr.slice(0, 64),
    preset: input.preset.slice(0, 80),
    customPorts: typeof input.customPorts === "string" ? input.customPorts.trim().slice(0, 500) : "",
    intervalMinutes,
    createdAt: validDate(input.createdAt) ?? new Date().toISOString(),
    updatedAt: validDate(input.updatedAt) ?? new Date().toISOString(),
    nextRunAt: validDate(input.nextRunAt) ?? new Date(Date.now() + intervalMinutes * 60_000).toISOString(),
    lastRunAt: validDate(input.lastRunAt),
    lastStatus: ["running", "completed", "failed", "skipped"].includes(input.lastStatus) ? input.lastStatus : null,
    lastError: typeof input.lastError === "string" ? input.lastError.slice(0, 500) : null,
  };
}

function sanitizeNotification(input) {
  if (input?.type !== "new-port" || !validId(input?.fingerprint) || !validId(input?.scheduleId)) {
    throw badRequest("Invalid port notification");
  }
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw badRequest("Invalid notification port");
  return {
    id: validId(input.id) ? input.id : `notification:${crypto.randomUUID()}`,
    fingerprint: input.fingerprint,
    type: "new-port",
    scheduleId: input.scheduleId,
    snapshotId: validId(input.snapshotId) ? input.snapshotId : null,
    observedAt: validDate(input.observedAt) ?? new Date().toISOString(),
    protocol: input.protocol === "udp" ? "udp" : "tcp",
    address: String(input.address ?? "").slice(0, 64),
    port,
    service: typeof input.service === "string" ? input.service.slice(0, 120) : null,
    readAt: validDate(input.readAt),
  };
}

function validDate(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function sanitizeInterfacePolicy(input) {
  return {
    map: input?.map !== false,
    identity: input?.identity !== false,
    scan: input?.scan !== false,
  };
}

function sanitizeDeviceOverride(input) {
  const result = {};
  if (typeof input.name === "string") result.name = input.name.trim().slice(0, 120);
  if (typeof input.role === "string") result.role = input.role.trim().slice(0, 60);
  if (Array.isArray(input.tags)) result.tags = input.tags
    .filter((tag) => typeof tag === "string")
    .map((tag) => tag.trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 30);
  return result;
}

function sanitizeMerge(input) {
  const sourceIds = [...new Set((input?.sourceIds ?? []).filter((id) => typeof id === "string" && id.length <= 200))];
  if (sourceIds.length < 2 || sourceIds.length > 20) throw badRequest("A merge requires between 2 and 20 sourceIds");
  return {
    id: `merge:${crypto.randomUUID()}`,
    sourceIds,
    targetId: validId(input.targetId) ? input.targetId : sourceIds[0],
    name: typeof input.name === "string" ? input.name.trim().slice(0, 120) : undefined,
    role: typeof input.role === "string" ? input.role.trim().slice(0, 60) : undefined,
  };
}

function sanitizeSplit(input) {
  const addresses = [...new Set((input?.addresses ?? []).filter((value) => typeof value === "string" && value.length <= 64))];
  if (!validId(input?.sourceId) || !validId(input?.targetId) || !addresses.length) {
    throw badRequest("A split requires sourceId, targetId, and at least one address");
  }
  return {
    id: `split:${crypto.randomUUID()}`,
    sourceId: input.sourceId,
    targetId: input.targetId,
    addresses,
    name: typeof input.name === "string" ? input.name.trim().slice(0, 120) : undefined,
    role: typeof input.role === "string" ? input.role.trim().slice(0, 60) : undefined,
  };
}

function appendAudit(state, actor, action, details) {
  state.overrides.audit.push({
    id: `audit:${crypto.randomUUID()}`,
    at: new Date().toISOString(),
    actor: String(actor || "local-user").slice(0, 80),
    action,
    details,
  });
  state.overrides.audit = state.overrides.audit.slice(-500);
}

function validId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function badRequest(message) {
  const error = new Error(message);
  error.code = "BAD_REQUEST";
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.code = "NOT_FOUND";
  return error;
}

function sanitizeLayout(layout) {
  const result = {};
  if (!layout || typeof layout !== "object") return result;
  for (const [id, position] of Object.entries(layout)) {
    if (
      typeof id === "string" &&
      id.length <= 200 &&
      Number.isFinite(position?.x) &&
      Number.isFinite(position?.y)
    ) {
      result[id] = {
        x: Math.max(0, Math.min(20_000, Math.round(position.x))),
        y: Math.max(0, Math.min(20_000, Math.round(position.y))),
      };
    }
  }
  return result;
}
