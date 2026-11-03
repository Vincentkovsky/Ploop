import { randomUUID, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { openDatabase, transaction } from "./database.mjs";
import { PloopError, sha256 } from "./runtime.mjs";
import { feedbackSource, identifier, resultInput, terminalStates } from "./contracts.mjs";

export const token = () => randomBytes(32).toString("base64url");
export const tokenHash = (value) => sha256(String(value));
export function equalSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return timingSafeEqual(Buffer.from(tokenHash(left), "hex"), Buffer.from(tokenHash(right), "hex"));
}

export async function openHubStore(directory, { leaseMs = 30_000, clock = Date.now } = {}) {
  const db = await openDatabase(directory, "hub.sqlite", 0x504c4f50);
  try {
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version > 1) throw new PloopError("database_version", "Hub database is newer than this application");
    if (version === 0) transaction(db, () => db.exec(`
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, config TEXT NOT NULL, public_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL) STRICT;
      CREATE TABLE devices(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, last_seen INTEGER, revoked INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), request_id TEXT NOT NULL,
        receipt_hash TEXT NOT NULL, feedback_raw TEXT NOT NULL, state TEXT NOT NULL, phase TEXT NOT NULL, snapshot TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
        attempt_id TEXT, device_id TEXT REFERENCES devices(id), claim_id TEXT, lease_deadline INTEGER,
        cancel_requested INTEGER NOT NULL DEFAULT 0, result TEXT, UNIQUE(project_id, request_id)) STRICT;
      CREATE TABLE claims(device_id TEXT NOT NULL, claim_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY(device_id, claim_id)) STRICT;
      CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL REFERENCES tasks(id), type TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
      PRAGMA user_version=1;
    `));
    if (!db.prepare("SELECT value FROM meta WHERE key='lease_secret'").get()) db.prepare("INSERT INTO meta(key,value) VALUES('lease_secret',?)").run(token());
    return new HubStore(db, { leaseMs, clock });
  } catch (error) { db.close(); throw error; }
}

class HubStore {
  constructor(db, { leaseMs, clock }) { this.db = db; this.leaseMs = leaseMs; this.clock = clock; this.secret = db.prepare("SELECT value FROM meta WHERE key='lease_secret'").get().value; }
  close() { this.db.close(); }
  meta(key, value) {
    if (value !== undefined) this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
    return this.db.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value ?? null;
  }
  summary() { return this.db.prepare("SELECT state,COUNT(*) AS count FROM tasks GROUP BY state").all(); }
  event(id, type, data = {}, eventId = randomUUID()) {
    this.db.prepare("INSERT OR IGNORE INTO events(event_id,task_id,type,data,created_at) VALUES(?,?,?,?,?)").run(eventId, id, type, JSON.stringify(data), this.clock());
  }
  addProject(config, { id = randomUUID(), publicKey = token() } = {}) {
    this.db.prepare("INSERT INTO projects VALUES(?,?,?,?,?)").run(id, config.name, JSON.stringify(config), publicKey, this.clock());
    return this.project(id);
  }
  project(id) {
    const row = this.db.prepare("SELECT * FROM projects WHERE id=?").get(id);
    if (!row) throw new PloopError("not_found", "Project not found");
    return { id: row.id, name: row.name, config: JSON.parse(row.config), publicKey: row.public_key, createdAt: row.created_at };
  }
  projectByKey(key) {
    const row = this.db.prepare("SELECT id FROM projects WHERE public_key=?").get(key);
    if (!row) throw new PloopError("unauthorized", "Unknown project ingestion key");
    return this.project(row.id);
  }
  projects() { return this.db.prepare("SELECT id FROM projects ORDER BY created_at").all().map(({ id }) => this.project(id)); }
  addDevice(name, { id = randomUUID(), credential = token() } = {}) {
    this.db.prepare("INSERT INTO devices(id,name,token_hash) VALUES(?,?,?)").run(id, name, tokenHash(credential));
    return { id, name, token: credential };
  }
  deviceByToken(credential) {
    const row = this.db.prepare("SELECT id,name,revoked FROM devices WHERE token_hash=?").get(tokenHash(credential));
    if (!row || row.revoked) throw new PloopError("unauthorized", "Bridge credential is invalid or revoked");
    return row;
  }
  devices() { return this.db.prepare("SELECT id,name,last_seen AS lastSeen,revoked FROM devices").all(); }
  ingest(projectId, requestId, receiptKey, rawFeedback) {
    identifier(requestId, "Idempotency-Key");
    if (typeof receiptKey !== "string" || receiptKey.length < 32 || receiptKey.length > 128) throw new PloopError("invalid_request", "A client-owned receipt key is required");
    feedbackSource(rawFeedback);
    return transaction(this.db, () => {
      const existing = this.db.prepare("SELECT id,receipt_hash,feedback_raw FROM tasks WHERE project_id=? AND request_id=?").get(projectId, requestId);
      if (existing) {
        if (existing.receipt_hash !== tokenHash(receiptKey) || existing.feedback_raw !== rawFeedback) throw new PloopError("conflict", "Idempotency key already belongs to a different report");
        return { id: existing.id, duplicate: true };
      }
      const id = randomUUID(), now = this.clock();
      this.db.prepare("INSERT INTO tasks(id,project_id,request_id,receipt_hash,feedback_raw,state,phase,created_at,updated_at) VALUES(?,?,?,?,?,'new','awaiting_approval',?,?)")
        .run(id, projectId, requestId, tokenHash(receiptKey), rawFeedback, now, now);
      this.event(id, "feedback.received", { sourceSha256: sha256(rawFeedback) });
      return { id, duplicate: false };
    });
  }
  taskRow(id) {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
    if (!row) throw new PloopError("not_found", "Task not found");
    return row;
  }
  task(id, { events = true } = {}) {
    const r = this.taskRow(id);
    return { id: r.id, projectId: r.project_id, feedback: JSON.parse(r.feedback_raw), state: r.state, phase: r.phase,
      createdAt: r.created_at, updatedAt: r.updated_at, cancelRequested: !!r.cancel_requested, generation: r.generation,
      attemptId: r.attempt_id, deviceId: r.device_id, leaseDeadline: r.lease_deadline,
      result: r.result ? JSON.parse(r.result) : null,
      ...(events ? { eventCoverage: { total: this.db.prepare("SELECT COUNT(*) AS count FROM events WHERE task_id=?").get(id).count, retainedInResponse: "latest_200" }, events: this.db.prepare("SELECT sequence,type,data,created_at AS createdAt FROM events WHERE task_id=? ORDER BY sequence DESC LIMIT 200").all(id).reverse().map((e) => ({ ...e, data: JSON.parse(e.data) })) } : {}) };
  }
  tasks({ before, limit = 50 } = {}) {
    limit = Math.max(1, Math.min(100, limit));
    const rows = this.db.prepare("SELECT id,project_id AS projectId,json_extract(feedback_raw,'$.title') AS title,state,phase,cancel_requested AS cancelRequested,created_at AS createdAt,updated_at AS updatedAt FROM tasks WHERE (created_at < ? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?")
      .all(before?.createdAt ?? Number.MAX_SAFE_INTEGER, before?.createdAt ?? Number.MAX_SAFE_INTEGER, before?.id ?? "", limit + 1);
    const items = rows.slice(0, limit).map((r) => ({ ...r, cancelRequested: !!r.cancelRequested })), last = items.at(-1);
    return { items, nextCursor: rows.length > limit ? { createdAt: last.createdAt, id: last.id } : null };
  }
  receipt(id, key) {
    const r = this.taskRow(id);
    if (r.receipt_hash !== tokenHash(key)) throw new PloopError("unauthorized", "Receipt does not authorize this task");
    return { id: r.id, state: r.state, phase: r.phase, cancelRequested: !!r.cancel_requested, updatedAt: r.updated_at };
  }
  approve(id, snapshot) {
    return transaction(this.db, () => {
      const row = this.taskRow(id);
      if (row.state !== "new") throw new PloopError("conflict", "Only new feedback can be approved");
      this.db.prepare("UPDATE tasks SET state='queued',phase='queued',snapshot=?,updated_at=? WHERE id=?").run(JSON.stringify(snapshot), this.clock(), id);
      this.event(id, "task.approved", { baseCommit: snapshot.baseCommit, projectDigest: snapshot.digest });
      return this.task(id);
    });
  }
  cancel(id) {
    return transaction(this.db, () => {
      const row = this.taskRow(id);
      if (terminalStates.has(row.state)) return this.task(id);
      const state = ["new", "queued"].includes(row.state) ? "cancelled" : row.state;
      this.db.prepare("UPDATE tasks SET cancel_requested=1,state=?,updated_at=? WHERE id=?").run(state, this.clock(), id);
      this.event(id, "task.cancel_requested");
      return this.task(id);
    });
  }
  leaseToken(row) { return createHmac("sha256", this.secret).update(`${row.id}:${row.attempt_id}:${row.device_id}:${row.generation}`).digest("base64url"); }
  assignment(row) { return { taskId: row.id, state: row.state, attemptId: row.attempt_id, generation: row.generation, leaseToken: this.leaseToken(row), leaseDeadline: row.lease_deadline,
    feedback: JSON.parse(row.feedback_raw), feedbackRaw: row.feedback_raw, snapshot: JSON.parse(row.snapshot) }; }
  claim(deviceId, claimId) {
    identifier(claimId, "claimId");
    return transaction(this.db, () => {
      const previous = this.db.prepare("SELECT task_id FROM claims WHERE device_id=? AND claim_id=?").get(deviceId, claimId);
      if (previous) return this.assignment(this.taskRow(previous.task_id));
      if (this.db.prepare("SELECT id FROM tasks WHERE device_id=? AND state IN ('running','recovery_required') LIMIT 1").get(deviceId)) return null;
      const next = this.db.prepare("SELECT * FROM tasks WHERE state='queued' AND cancel_requested=0 ORDER BY created_at,id LIMIT 1").get();
      if (!next) return null;
      const attemptId = randomUUID(), now = this.clock();
      this.db.prepare("UPDATE tasks SET state='running',phase='preparing',attempt_id=?,device_id=?,claim_id=?,generation=generation+1,lease_deadline=?,updated_at=? WHERE id=?")
        .run(attemptId, deviceId, claimId, now + this.leaseMs, now, next.id);
      this.db.prepare("INSERT INTO claims VALUES(?,?,?)").run(deviceId, claimId, next.id);
      this.event(next.id, "task.claimed", { attemptId, deviceId });
      return this.assignment(this.taskRow(next.id));
    });
  }
  authorizeAttempt(deviceId, id, attemptId, generation, credential) {
    const row = this.taskRow(id);
    if (row.device_id !== deviceId || row.attempt_id !== attemptId || row.generation !== generation || !equalSecret(credential, this.leaseToken(row)))
      throw new PloopError("conflict", "Attempt no longer owns this task");
    return row;
  }
  heartbeat(deviceId, active) {
    return transaction(this.db, () => {
      const now = this.clock(); this.db.prepare("UPDATE devices SET last_seen=? WHERE id=?").run(now, deviceId);
      if (!active) return { now, leaseMs: this.leaseMs };
      const row = this.authorizeAttempt(deviceId, active.taskId, active.attemptId, active.generation, active.leaseToken);
      if (row.state === "running") this.db.prepare("UPDATE tasks SET lease_deadline=? WHERE id=?").run(now + this.leaseMs, row.id);
      return { now, leaseDeadline: now + this.leaseMs, state: row.state, cancelRequested: !!row.cancel_requested };
    });
  }
  progress(deviceId, assignment, eventId, type, data) {
    return transaction(this.db, () => {
      const row = this.authorizeAttempt(deviceId, assignment.taskId, assignment.attemptId, assignment.generation, assignment.leaseToken);
      const old = this.db.prepare("SELECT task_id,type,data FROM events WHERE event_id=?").get(eventId);
      if (old) {
        if (old.task_id !== row.id || old.type !== type || old.data !== JSON.stringify(data)) throw new PloopError("conflict", "Event identity belongs to different data");
        return;
      }
      if (terminalStates.has(row.state)) return;
      if (type === "execution.phase") {
        if (!["preparing", "baseline", "running", "freezing", "verifying", "verified"].includes(data.phase)) throw new PloopError("invalid_request", "Unknown execution phase");
        this.db.prepare("UPDATE tasks SET phase=?,updated_at=? WHERE id=?").run(data.phase, this.clock(), row.id);
      }
      this.event(row.id, type, data, eventId);
    });
  }
  finish(deviceId, assignment, eventId, report) {
    resultInput(report);
    return transaction(this.db, () => {
      const row = this.authorizeAttempt(deviceId, assignment.taskId, assignment.attemptId, assignment.generation, assignment.leaseToken);
      const snapshot = JSON.parse(row.snapshot);
      if (report.id !== row.id || report.baseCommit !== snapshot.baseCommit || report.projectDigest !== snapshot.digest ||
        (report.status === "verified" && report.verification.summary.tests !== snapshot.config.acceptance.expectedTests))
        throw new PloopError("conflict", "Result does not describe the approved task snapshot");
      const digest = sha256(JSON.stringify(report));
      const exists = this.db.prepare("SELECT task_id,data FROM events WHERE event_id=?").get(eventId);
      if (exists) {
        if (exists.task_id !== row.id || JSON.parse(exists.data).resultDigest !== digest) throw new PloopError("conflict", "Event identity belongs to a different result");
        return this.task(row.id);
      }
      if (terminalStates.has(row.state)) throw new PloopError("conflict", "Task already has a different terminal result");
      this.db.prepare("UPDATE tasks SET state=?,phase=?,result=?,updated_at=? WHERE id=?").run(report.status, report.status, JSON.stringify(report), this.clock(), row.id);
      this.event(row.id, "task.finished", { status: report.status, resultDigest: digest, lateCancellation: !!row.cancel_requested && report.status !== "cancelled" }, eventId);
      return this.task(row.id);
    });
  }
  recover(deviceId, assignment, reason, eventId = randomUUID()) {
    return transaction(this.db, () => {
      const row = this.authorizeAttempt(deviceId, assignment.taskId, assignment.attemptId, assignment.generation, assignment.leaseToken);
      const previous = this.db.prepare("SELECT task_id,type,data FROM events WHERE event_id=?").get(eventId);
      if (previous) {
        if (previous.task_id !== row.id || previous.type !== "task.recovery_required" || previous.data !== JSON.stringify({ reason })) throw new PloopError("conflict", "Recovery event belongs to different data");
        return;
      }
      if (terminalStates.has(row.state)) return;
      this.db.prepare("UPDATE tasks SET state='recovery_required',phase='recovery_required',updated_at=? WHERE id=?").run(this.clock(), row.id);
      this.event(row.id, "task.recovery_required", { reason }, eventId);
    });
  }
  expire() {
    return transaction(this.db, () => {
      const rows = this.db.prepare("SELECT id FROM tasks WHERE state='running' AND lease_deadline < ?").all(this.clock());
      for (const { id } of rows) {
        this.db.prepare("UPDATE tasks SET state='recovery_required',phase='recovery_required',updated_at=? WHERE id=?").run(this.clock(), id);
        this.event(id, "task.lease_expired", { automaticReassignment: false });
      }
      return rows.length;
    });
  }
}
