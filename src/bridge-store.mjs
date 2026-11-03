import { randomUUID } from "node:crypto";
import { openDatabase, transaction } from "./database.mjs";
import { PloopError } from "./runtime.mjs";

export async function openBridgeStore(directory, binding) {
  const db = await openDatabase(directory, "bridge.sqlite", 0x504c4252);
  try {
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version > 1) throw new PloopError("database_version", "Bridge database is newer than this application");
    if (version === 0) transaction(db, () => db.exec(`
      CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
      CREATE TABLE active(task_id TEXT PRIMARY KEY,assignment TEXT NOT NULL,directory TEXT NOT NULL,stage TEXT NOT NULL) STRICT;
      CREATE TABLE seen(attempt_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,state TEXT NOT NULL) STRICT;
      CREATE TABLE outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,assignment TEXT NOT NULL,payload TEXT NOT NULL) STRICT;
      PRAGMA user_version=1;
    `));
    const selected = JSON.stringify(binding), previous = db.prepare("SELECT value FROM meta WHERE key='binding'").get()?.value;
    if (previous && previous !== selected) throw new PloopError("bridge_binding_changed", "Bridge journal belongs to another Hub/device; use a separate data directory");
    if (!previous) db.prepare("INSERT INTO meta VALUES('binding',?)").run(selected);
    return new BridgeStore(db);
  } catch (error) { db.close(); throw error; }
}
class BridgeStore {
  constructor(db) { this.db = db; }
  close() { this.db.close(); }
  claimId() {
    return transaction(this.db, () => {
      const previous = this.db.prepare("SELECT value FROM meta WHERE key='claim'").get();
      if (previous) return previous.value;
      const id = randomUUID(); this.db.prepare("INSERT INTO meta VALUES('claim',?)").run(id); return id;
    });
  }
  clearClaim() { this.db.prepare("DELETE FROM meta WHERE key='claim'").run(); }
  active() {
    return this.db.prepare("SELECT * FROM active ORDER BY rowid").all().map((row) => ({ taskId: row.task_id, assignment: JSON.parse(row.assignment), directory: row.directory, stage: row.stage }));
  }
  begin(assignment, directory) {
    return transaction(this.db, () => {
      if (this.db.prepare("SELECT attempt_id FROM seen WHERE attempt_id=?").get(assignment.attemptId)) { this.clearClaim(); return false; }
      if (this.db.prepare("SELECT task_id FROM active LIMIT 1").get()) throw new PloopError("bridge_capacity", "This Bridge already owns an unfinished execution");
      this.db.prepare("INSERT INTO active VALUES(?,?,?,'running')").run(assignment.taskId, JSON.stringify(assignment), directory);
      this.db.prepare("INSERT INTO seen VALUES(?,?,'active')").run(assignment.attemptId, assignment.taskId); this.clearClaim(); return true;
    });
  }
  enqueue(kind, assignment, payload) {
    const eventId = randomUUID();
    this.db.prepare("INSERT INTO outbox(event_id,kind,assignment,payload) VALUES(?,?,?,?)").run(eventId, kind, JSON.stringify(assignment), JSON.stringify(payload));
    return eventId;
  }
  stageResult(assignment, report) {
    return transaction(this.db, () => {
      const row = this.db.prepare("SELECT stage FROM active WHERE task_id=?").get(assignment.taskId);
      if (!row || row.stage === "result_staged") return;
      this.enqueue("finish", assignment, { report });
      this.db.prepare("UPDATE active SET stage='result_staged' WHERE task_id=?").run(assignment.taskId);
    });
  }
  stageRecovery(assignment, reason) {
    return transaction(this.db, () => {
      const row = this.db.prepare("SELECT stage FROM active WHERE task_id=?").get(assignment.taskId);
      if (!row || row.stage === "recovery_required") return;
      this.enqueue("recover", assignment, { reason });
      this.db.prepare("UPDATE active SET stage='recovery_required' WHERE task_id=?").run(assignment.taskId);
    });
  }
  pending(limit = 10) {
    return this.db.prepare("SELECT * FROM outbox ORDER BY sequence LIMIT ?").all(limit).map((row) => ({ sequence: row.sequence, eventId: row.event_id, kind: row.kind, assignment: JSON.parse(row.assignment), payload: JSON.parse(row.payload) }));
  }
  acknowledge(item) {
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM outbox WHERE event_id=?").run(item.eventId);
      if (item.kind === "finish") {
        this.db.prepare("UPDATE seen SET state='completed' WHERE attempt_id=?").run(item.assignment.attemptId);
        this.db.prepare("DELETE FROM active WHERE task_id=? AND json_extract(assignment,'$.attemptId')=?").run(item.assignment.taskId, item.assignment.attemptId);
      }
    });
  }
  counts() { return { active: this.db.prepare("SELECT COUNT(*) AS n FROM active").get().n, outbox: this.db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n }; }
}
