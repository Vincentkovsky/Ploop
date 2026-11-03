import { mkdir, stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { PloopError } from "./runtime.mjs";

export async function openDatabase(directory, name, applicationId) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch { throw new PloopError("sqlite_unavailable", "Start this Node version with --experimental-sqlite (npm run hub / npm run bridge)"); }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  const existed = await stat(path).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
  const db = new DatabaseSync(path);
  try {
    const id = db.prepare("PRAGMA application_id").get().application_id;
    if (existed && id !== applicationId) throw new PloopError("database_ownership_unknown", "Existing database has unknown ownership; it was not migrated", { path });
    db.exec("PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE;");
    if (!existed) { db.exec(`PRAGMA application_id=${applicationId}`); await chmod(path, 0o600); }
    return db;
  } catch (error) { db.close(); throw error; }
}

export function transaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
