import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startHub } from "../src/hub.mjs";
import { runBridge } from "../src/bridge.mjs";
import { token } from "../src/hub-store.mjs";
import { createServer, request as httpRequest } from "node:http";
import { HubClient } from "../src/http.mjs";

const feedback = await readFile(new URL("../examples/orders/feedback.json", import.meta.url), "utf8");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await pause(25); }
  throw new Error("Condition did not complete");
}
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "ploop-http-"));
  let hub = await startHub({ directory: join(root, "hub"), port: 0 });
  t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
  return { root, get hub() { return hub; }, restart: async () => { const port = Number(new URL(hub.url).port); await hub.close(); hub = await startHub({ directory: join(root, "hub"), port }); } };
}
const admin = (hub) => ({ authorization: `Bearer ${hub.adminToken}`, "content-type": "application/json" });
async function submit(hub) {
  const demo = await fetch(`${hub.url}/api/demo`).then((r) => r.json()), receiptKey = token();
  const response = await fetch(`${hub.url}/api/feedback`, { method: "POST", headers: { authorization: `Ingest ${demo.projectKey}`, "idempotency-key": randomUUID(), "x-ploop-receipt-key": receiptKey, "content-type": "application/json" }, body: feedback });
  assert.equal(response.status, 201); return { ...await response.json(), receiptKey, projectKey: demo.projectKey };
}

test("HTTP ingress and receipt never grant task execution or admin access", async (t) => {
  const f = await setup(t), receipt = await submit(f.hub);
  const listing = await fetch(`${f.hub.url}/api/tasks`, { headers: { authorization: `Ingest ${receipt.projectKey}` } }); assert.equal(listing.status, 401);
  const approve = await fetch(`${f.hub.url}/api/tasks/${receipt.id}/approve`, { method: "POST", headers: { authorization: `Receipt ${receipt.receiptKey}` } }); assert.equal(approve.status, 401);
  const status = await fetch(`${f.hub.url}/api/receipts/${receipt.id}`, { headers: { authorization: `Receipt ${receipt.receiptKey}` } }).then((r) => r.json());
  assert.equal(status.state, "new"); assert.equal(status.feedback, undefined); assert.equal(status.result, undefined);
  const external = await fetch(`${f.hub.url}/api/tasks`, { headers: { ...admin(f.hub), origin: "https://untrusted.example" } }); assert.equal(external.status, 403);
  const excessive = await fetch(`${f.hub.url}/api/feedback`, { method: "POST", headers: { authorization: `Ingest ${receipt.projectKey}`, "idempotency-key": randomUUID(), "x-ploop-receipt-key": token() }, body: " ".repeat(70_000) }); assert.equal(excessive.status, 413);
  const connection = JSON.parse(await readFile(f.hub.connectionFile, "utf8"));
  await assert.rejects(() => new HubClient(f.hub.url, connection.token).request("/api/bridge/heartbeat", { active: {} }), { code: "invalid_request" });
  const sdk = await fetch(`${f.hub.url}/sdk.mjs`, { headers: { origin: "https://other-app.example" } }); assert.equal(sdk.status, 200); assert.equal(sdk.headers.get("access-control-allow-origin"), "*");
});

for (const loss of ["headers", "body"]) test(`a lost finish response (${loss}) is retried without executing the task again`, async (t) => {
  const f = await setup(t), receipt = await submit(f.hub), controller = new AbortController();
  const approved = await fetch(`${f.hub.url}/api/tasks/${receipt.id}/approve`, { method: "POST", headers: admin(f.hub) }); assert.equal(approved.status, 200);
  let dropped = false, executions = 0;
  const proxy = createServer((incoming, outgoing) => {
    const upstream = httpRequest(new URL(incoming.url, f.hub.url), { method: incoming.method, headers: { ...incoming.headers, host: new URL(f.hub.url).host } }, (response) => {
      if (incoming.url === "/api/bridge/finish" && !dropped && response.statusCode === 200) {
        dropped = true; response.resume(); response.once("end", () => {
          if (loss === "body") { outgoing.writeHead(200, { "content-type": "application/json", "content-length": "1000" }); outgoing.write("{"); setImmediate(() => outgoing.destroy()); }
          else outgoing.destroy();
        });
      } else { outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing); }
    });
    upstream.on("error", () => outgoing.destroy()); incoming.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const worker = runBridge({ hub: `http://127.0.0.1:${proxy.address().port}`, connectionFile: f.hub.connectionFile, directory: join(f.root, "bridge"), pollMs: 25, heartbeatMs: 50, signal: controller.signal,
    executor: async ({ id, snapshot, directory }) => { executions++; return { schemaVersion: 1, id, status: "failed", baseCommit: snapshot.baseCommit, projectDigest: snapshot.digest, directory, finishedAt: new Date().toISOString(), error: { code: "controlled_test" } }; } });
  worker.catch(() => {});
  try {
    await until(() => dropped && f.hub.store.task(receipt.id).state === "failed");
    controller.abort(); const result = await worker;
    assert.equal(executions, 1); assert.equal(result.outbox, 0); assert.equal(result.active, 0);
    assert.equal(f.hub.store.task(receipt.id).events.filter((e) => e.type === "task.finished").length, 1);
  } finally { controller.abort(); await worker; await new Promise((resolve) => proxy.close(resolve)); }
});

test("a running Bridge survives Hub restart and reports one execution result", async (t) => {
  const f = await setup(t), receipt = await submit(f.hub), controller = new AbortController();
  const approved = await fetch(`${f.hub.url}/api/tasks/${receipt.id}/approve`, { method: "POST", headers: admin(f.hub) }); assert.equal(approved.status, 200);
  let executions = 0, finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const worker = runBridge({ hub: f.hub.url, connectionFile: f.hub.connectionFile, directory: join(f.root, "bridge"), pollMs: 25, heartbeatMs: 50, signal: controller.signal,
    executor: async ({ id, snapshot, directory }) => {
      executions++; await gate;
      return { schemaVersion: 1, id, status: "failed", baseCommit: snapshot.baseCommit, projectDigest: snapshot.digest, directory, finishedAt: new Date().toISOString(), error: { code: "controlled_test" } };
    } });
  worker.catch(() => {});
  try {
    await until(() => executions === 1);
    await f.restart();
    assert.equal(f.hub.store.task(receipt.id).state, "running"); finish();
    await until(() => f.hub.store.task(receipt.id).state === "failed");
    assert.equal(executions, 1);
    assert.equal(f.hub.store.task(receipt.id).events.filter((e) => e.type === "task.finished").length, 1);
  } finally { finish(); controller.abort(); await worker; }
});
