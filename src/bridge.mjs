import { readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HubClient } from "./http.mjs";
import { openBridgeStore } from "./bridge-store.mjs";
import { executeTask } from "./execution.mjs";
import { PloopError, sha256 } from "./runtime.mjs";
import { assignmentInput, terminalStates } from "./contracts.mjs";
import { projectRoot } from "./paths.mjs";

const delay = (ms, signal) => new Promise((resolve) => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms); signal?.addEventListener("abort", done, { once: true }); if (signal?.aborted) done();
});
const excerpt = (value, limit) => typeof value === "string" ? { text: value.slice(-limit), omittedBytes: Math.max(0, Buffer.byteLength(value) - Buffer.byteLength(value.slice(-limit))) } : null;
export async function resultForHub(report) {
  const verification = (result) => result ? { commit: result.commit, code: result.code, summary: result.summary, elapsedMs: result.elapsedMs,
    acceptanceSha256: result.acceptanceSha256, snapshotSha256: result.snapshotSha256, stdout: excerpt(result.stdout, 12_000), stderr: excerpt(result.stderr, 4000) } : undefined;
  const selected = { schemaVersion: 1, id: report.id, status: report.status, baseCommit: report.baseCommit, projectDigest: report.projectDigest,
    candidateCommit: report.candidateCommit, verification: verification(report.verification), baseline: verification(report.baseline), metrics: report.metrics,
    error: report.error, finishedAt: report.finishedAt, reportDirectory: report.directory,
    agent: report.agent ? { model: report.agent.model, status: report.agent.status, threadId: report.agent.threadId, turnId: report.agent.turnId, finalMessage: excerpt(report.agent.messages?.at(-1), 8000) } : null,
    coverage: { rawReport: "retained_on_bridge", protocol: "projected_events", artifactLocation: report.directory }, limitations: report.limitations };
  if (report.status === "verified") {
    try {
      const patch = await readFile(join(report.directory, "fix.patch"), "utf8");
      if (sha256(patch) !== report.patchSha256) throw new Error("Patch digest changed");
      if (Buffer.byteLength(JSON.stringify(patch)) > 2 * 1024 * 1024) selected.artifactNotice = "Patch retained locally because it exceeds the inline representation budget";
      else { selected.patch = patch; selected.patchSha256 = report.patchSha256; }
    } catch { selected.artifactNotice = "Patch could not be read or its digest changed; inspect the retained Bridge report"; }
  }
  return selected;
}

export async function flushOutbox(store, client) {
  for (const item of store.pending()) {
    await client.request(`/api/bridge/${item.kind}`, { assignment: item.assignment, eventId: item.eventId, ...item.payload });
    store.acknowledge(item);
  }
}
export async function reconcileBridge(store) {
  for (const row of store.active()) {
    if (row.stage === "result_staged") continue;
    try {
      const report = JSON.parse(await readFile(join(row.directory, "report.json"), "utf8"));
      const owner = JSON.parse(await readFile(join(row.directory, "owner.json"), "utf8"));
      if (report.id === row.taskId && owner.id === row.taskId && report.projectDigest === row.assignment.snapshot.digest && owner.projectDigest === report.projectDigest && report.finishedAt && terminalStates.has(report.status)) {
        store.stageResult(row.assignment, await resultForHub(report)); continue;
      }
    } catch { /* Missing or incomplete records do not prove execution stopped. */ }
    store.stageRecovery(row.assignment, "Bridge restarted without a confirmed terminal report. Execution and worktree are retained; no automatic retry or process killing.");
  }
}

export async function runBridge({ hub = "http://127.0.0.1:4317", connectionFile = join(projectRoot, ".ploop/hub/bridge.json"), directory = join(projectRoot, ".ploop/bridge"),
  executable = "codex", model, timeoutMs = 180_000, pollMs = 1000, heartbeatMs = 2000, signal, onProgress = () => {}, executor = executeTask } = {}) {
  const connection = JSON.parse(await readFile(connectionFile, "utf8"));
  if (connection.schemaVersion !== 1 || connection.kind !== "ploop-bridge-connection" || typeof connection.token !== "string" || connection.token.length < 32 || typeof connection.deviceId !== "string")
    throw new PloopError("configuration_invalid", "Bridge connection has an unknown format");
  const client = new HubClient(hub, connection.token);
  directory = resolve(directory); await mkdir(join(directory, "runs"), { recursive: true, mode: 0o700 });
  const store = await openBridgeStore(directory, { hub: client.url, deviceId: connection.deviceId, credentialHash: sha256(connection.token) });
  let running = null, controller = null, lastHeartbeat = 0, heartbeatDeadline = 0, shutdownDeadline = null, lastError = null, persistenceFailure = null;
  const cancel = () => { shutdownDeadline ??= Date.now() + 15_000; controller?.abort(new PloopError("cancelled", "Bridge shutdown requested")); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    await reconcileBridge(store); if (signal?.aborted) cancel();
    onProgress("connected", { hub: client.url, deviceId: connection.deviceId, ...store.counts() });
    while (true) {
      if (persistenceFailure) throw new PloopError("bridge_storage_failed", "Bridge could not retain execution state; inspect the original journal and worktree", { causeCode: persistenceFailure.code ?? "unexpected" });
      if (signal?.aborted && !running && (!store.counts().outbox || Date.now() > shutdownDeadline)) break;
      try {
        await flushOutbox(store, client);
        const active = store.active()[0];
        if (Date.now() - lastHeartbeat >= heartbeatMs) {
          const heartbeat = await client.request("/api/bridge/heartbeat", { active: active?.assignment ?? null });
          lastHeartbeat = Date.now(); heartbeatDeadline = Date.now() + Math.max(1000, (heartbeat.leaseDeadline ?? Date.now() + heartbeat.leaseMs) - heartbeat.now);
          if (heartbeat.cancelRequested || heartbeat.state === "recovery_required") controller?.abort(new PloopError("cancelled", "Hub requested cancellation or execution reconciliation"));
        }
        if (active?.stage === "recovery_required" && !running && !store.counts().outbox) {
          onProgress("recovery_required", { taskId: active.taskId, directory: active.directory }); return { state: "recovery_required", ...store.counts() };
        }
        if (!active && !running && !signal?.aborted) {
          const assignment = await client.request("/api/bridge/claim", { claimId: store.claimId() });
          if (assignment) {
            assignmentInput(assignment);
            if (!["running", "recovery_required", ...terminalStates].includes(assignment.state)) throw new PloopError("protocol_invalid", "Hub returned an unknown assignment state");
            if (terminalStates.has(assignment.state)) store.clearClaim();
            else if (assignment.state === "recovery_required") {
              const runDirectory = join(directory, "runs", assignment.attemptId);
              if (store.begin(assignment, runDirectory)) store.stageRecovery(assignment, "Assignment requires reconciliation; no execution was started by this Bridge process");
            } else {
              const runDirectory = join(directory, "runs", assignment.attemptId);
              if (store.begin(assignment, runDirectory)) {
                controller = new AbortController(); heartbeatDeadline = assignment.leaseDeadline;
                if (signal?.aborted) controller.abort(new PloopError("cancelled", "Bridge shutdown requested"));
                onProgress("running", { taskId: assignment.taskId, attemptId: assignment.attemptId });
                running = Promise.resolve().then(() => executor({ id: assignment.taskId, directory: runDirectory, snapshot: assignment.snapshot, feedbackRaw: assignment.feedbackRaw,
                  executable, model, timeoutMs, signal: controller.signal,
                  onEvent: (type, data) => { store.enqueue("progress", assignment, { type, data }); } }))
                  .then(async (report) => {
                    if (terminalStates.has(report.status)) store.stageResult(assignment, await resultForHub(report));
                    else store.stageRecovery(assignment, "Execution cleanup or finalization could not be confirmed; inspect the retained report");
                    onProgress(report.status, { taskId: assignment.taskId });
                  })
                  .catch((error) => {
                    try { store.stageRecovery(assignment, `Execution did not produce a confirmed terminal report: ${error.code ?? "unexpected"}`); }
                    catch (storageError) { persistenceFailure = storageError; }
                    onProgress("recovery_required", { taskId: assignment.taskId, code: error.code ?? "unexpected" });
                  })
                  .finally(() => { running = null; controller = null; });
              }
            }
          }
        }
        lastError = null;
      } catch (error) {
        if (lastError !== error.code) { onProgress("connection_wait", { code: error.code, message: error.message }); lastError = error.code; }
        if (error.code !== "hub_unreachable") {
          controller?.abort(new PloopError("cancelled", "Hub no longer authorizes this Bridge operation"));
          if (!running) throw error;
        }
        if (running && heartbeatDeadline && Date.now() > heartbeatDeadline) controller?.abort(new PloopError("hub_unreachable", "Hub lease could not be renewed"));
      }
      await delay(pollMs, signal?.aborted ? undefined : signal);
    }
    return { state: "stopped", ...store.counts() };
  } finally {
    signal?.removeEventListener("abort", cancel);
    controller?.abort(new PloopError("cancelled", "Bridge is stopping"));
    if (running) await running;
    store.close();
  }
}
