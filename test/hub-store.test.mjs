import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openHubStore, token } from "../src/hub-store.mjs";
import { openBridgeStore } from "../src/bridge-store.mjs";
import { reconcileBridge } from "../src/bridge.mjs";
import { resultInput } from "../src/contracts.mjs";

const raw = await readFile(new URL("../examples/orders/feedback.json", import.meta.url), "utf8");
const snapshot = { digest: "project-digest", baseCommit: "a".repeat(40), config: { acceptance: { expectedTests: 8 } } };
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "ploop-store-"));
  let store = await openHubStore(root, { clock: () => 1000, leaseMs: 100 });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const project = store.addProject({ name: "Test project" }), device = store.addDevice("Test Bridge");
  const add = () => { const receipt = token(), request = randomUUID(), task = store.ingest(project.id, request, receipt, raw); return { ...task, receipt, request }; };
  return { root, get store() { return store; }, project, device, add, reopen: async () => { store.close(); store = await openHubStore(root, { clock: () => 2000, leaseMs: 100 }); return store; } };
}
const failed = (id) => ({ schemaVersion: 1, id, status: "failed", baseCommit: snapshot.baseCommit, projectDigest: snapshot.digest, error: { code: "test" } });

test("feedback idempotency preserves source and cannot reveal another receipt", async (t) => {
  const f = await setup(t), task = f.add();
  assert.equal(f.store.ingest(f.project.id, task.request, task.receipt, raw).id, task.id);
  assert.throws(() => f.store.ingest(f.project.id, task.request, token(), raw), { code: "conflict" });
  assert.throws(() => f.store.receipt(task.id, token()), { code: "unauthorized" });
  assert.deepEqual(Object.keys(f.store.receipt(task.id, task.receipt)).sort(), ["cancelRequested", "id", "phase", "state", "updatedAt"]);
  assert.equal(f.store.tasks().items.length, 1);
});

test("a duplicate claim has the same attempt and a second device cannot run it", async (t) => {
  const f = await setup(t), task = f.add(); f.store.approve(task.id, snapshot);
  const claimId = randomUUID(), a = f.store.claim(f.device.id, claimId), b = f.store.claim(f.device.id, claimId);
  assert.equal(a.attemptId, b.attemptId); assert.equal(a.leaseToken, b.leaseToken);
  assert.equal(f.store.claim(f.store.addDevice("Other device").id, randomUUID()), null);
});

test("Hub restart retains the attempt and accepts a late terminal result once", async (t) => {
  const f = await setup(t), task = f.add(); f.store.approve(task.id, snapshot);
  const a = f.store.claim(f.device.id, randomUUID()), eventId = randomUUID();
  await f.reopen();
  assert.equal(f.store.task(task.id).attemptId, a.attemptId);
  assert.equal(f.store.expire(), 1);
  assert.equal(f.store.task(task.id).state, "recovery_required");
  assert.equal(f.store.claim(f.device.id, randomUUID()), null);
  f.store.finish(f.device.id, a, eventId, failed(task.id));
  f.store.finish(f.device.id, a, eventId, failed(task.id));
  assert.equal(f.store.task(task.id).events.filter((e) => e.type === "task.finished").length, 1);
  assert.throws(() => f.store.finish(f.device.id, { ...a, generation: a.generation - 1 }, randomUUID(), failed(task.id)), { code: "conflict" });
});

test("result identity, acceptance coverage and event payload cannot be substituted", async (t) => {
  const f = await setup(t), task = f.add(); f.store.approve(task.id, snapshot);
  const a = f.store.claim(f.device.id, randomUUID()), eventId = randomUUID();
  assert.throws(() => f.store.finish(f.device.id, a, eventId, failed("different-task")), { code: "conflict" });
  assert.throws(() => resultInput({ schemaVersion: 1, status: "verified", candidateCommit: "a".repeat(40), verification: { commit: "a".repeat(40), code: 0, summary: { fail: 0 } } }), { code: "invalid_request" });
  f.store.finish(f.device.id, a, eventId, failed(task.id));
  assert.throws(() => f.store.finish(f.device.id, a, eventId, { ...failed(task.id), error: { code: "different" } }), { code: "conflict" });
});

test("cancellation is an intent until a running Bridge reports its actual outcome", async (t) => {
  const f = await setup(t), queued = f.add(); f.store.approve(queued.id, snapshot); f.store.cancel(queued.id);
  assert.equal(f.store.task(queued.id).state, "cancelled");
  const active = f.add(); f.store.approve(active.id, snapshot);
  const a = f.store.claim(f.device.id, randomUUID()); f.store.cancel(active.id);
  assert.equal(f.store.task(active.id).state, "running");
  assert.equal(f.store.heartbeat(f.device.id, a).cancelRequested, true);
});

test("pagination does not omit tasks with identical timestamps", async (t) => {
  const f = await setup(t); for (let i = 0; i < 5; i++) f.add();
  const seen = [], first = f.store.tasks({ limit: 2 }); seen.push(...first.items.map((t) => t.id));
  const second = f.store.tasks({ limit: 2, before: first.nextCursor }); seen.push(...second.items.map((t) => t.id));
  const third = f.store.tasks({ limit: 2, before: second.nextCursor }); seen.push(...third.items.map((t) => t.id));
  assert.equal(seen.length, 5); assert.equal(new Set(seen).size, 5); assert.equal(third.nextCursor, null);
});

test("Bridge persists claim intent, outbox and unfinished ownership across restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ploop-bridge-store-"));
  const binding = { hub: "http://127.0.0.1:4317", deviceId: "device", credentialHash: "hash" };
  let store = await openBridgeStore(root, binding);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const claimId = store.claimId(); store.close(); store = await openBridgeStore(root, binding); assert.equal(store.claimId(), claimId);
  const a = { taskId: randomUUID(), attemptId: randomUUID(), generation: 1 };
  assert.equal(store.begin(a, "/owned/run"), true);
  store.stageResult(a, { status: "failed" }); store.close(); store = await openBridgeStore(root, binding);
  const item = store.pending()[0]; assert.equal(item.kind, "finish"); assert.equal(store.counts().active, 1);
  store.acknowledge(item); assert.deepEqual(store.counts(), { active: 0, outbox: 0 });
  assert.equal(store.begin(a, "/owned/run"), false);
});


test("Bridge restart retains an uncertain execution and never begins it twice", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ploop-reconcile-"));
  const binding = { hub: "http://127.0.0.1:4317", deviceId: "device", credentialHash: "hash" };
  let store = await openBridgeStore(root, binding);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const assignment = { taskId: randomUUID(), attemptId: randomUUID(), generation: 1, snapshot };
  const directory = join(root, "run"); store.begin(assignment, directory);
  store.close(); store = await openBridgeStore(root, binding);
  await reconcileBridge(store);
  assert.equal(store.active()[0].stage, "recovery_required");
  assert.equal(store.pending()[0].kind, "recover");
  assert.equal(store.begin(assignment, directory), false);
  store.acknowledge(store.pending()[0]);
  assert.deepEqual(store.counts(), { active: 1, outbox: 0 });
  await mkdir(directory);
  const report = { ...failed(assignment.taskId), directory, finishedAt: new Date().toISOString() };
  await writeFile(join(directory, "owner.json"), JSON.stringify({ id: report.id, projectDigest: report.projectDigest }));
  await writeFile(join(directory, "report.json"), JSON.stringify(report));
  store.close(); store = await openBridgeStore(root, binding);
  await reconcileBridge(store);
  assert.equal(store.pending()[0].kind, "finish");
  store.acknowledge(store.pending()[0]);
  assert.deepEqual(store.counts(), { active: 0, outbox: 0 });
});

test("recovery reports are idempotent and cannot substitute another payload", async (t) => {
  const f = await setup(t), task = f.add(); f.store.approve(task.id, snapshot);
  const a = f.store.claim(f.device.id, randomUUID()), event = randomUUID();
  f.store.recover(f.device.id, a, "Missing terminal report", event);
  f.store.recover(f.device.id, a, "Missing terminal report", event);
  const detail = f.store.task(task.id);
  assert.equal(detail.state, "recovery_required");
  assert.equal(detail.events.filter((e) => e.type === "task.recovery_required").length, 1);
  assert.equal(detail.eventCoverage.total, detail.events.length);
  assert.throws(() => f.store.recover(f.device.id, a, "Different reason", event), { code: "conflict" });
  assert.throws(() => f.store.progress(f.device.id, a, randomUUID(), "execution.phase", { phase: null }), { code: "invalid_request" });
});
