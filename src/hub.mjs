import { createServer } from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openHubStore, equalSecret, token } from "./hub-store.mjs";
import { PloopError, sha256 } from "./runtime.mjs";
import { projectRoot } from "./paths.mjs";
import { seedRepository, bindDemo } from "./demo.mjs";
import { bindProject, snapshotProject } from "./projects.mjs";
import { bearer, parseJSON, readRequest, sendJSON, statusFor } from "./http.mjs";
import { assignmentInput, identifier, object, text } from "./contracts.mjs";

async function hubSecrets(directory) {
  const path = join(directory, "secrets.json");
  try {
    const value = parseJSON(await readFile(path, "utf8"));
    if (value?.schemaVersion !== 1 || value.kind !== "ploop-hub" || typeof value.adminToken !== "string" || value.adminToken.length < 32) throw new PloopError("configuration_invalid", "Hub secrets file has unknown ownership or format");
    return value;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const value = { schemaVersion: 1, kind: "ploop-hub", adminToken: token() };
    await writeFile(path, JSON.stringify(value), { mode: 0o600, flag: "wx" }); return value;
  }
}

export async function startHub({ directory = join(projectRoot, ".ploop/hub"), port = 4317, demo = true, leaseMs = 30_000, clock = Date.now } = {}) {
  directory = resolve(directory);
  const store = await openHubStore(directory, { leaseMs, clock });
  let secrets;
  try { secrets = await hubSecrets(directory); } catch (error) { store.close(); throw error; }
  let origin, ready = false, maintenanceFailure = false;
  const assets = new Map([["/", ["index.html", "text/html"]], ["/app.mjs", ["app.mjs", "text/javascript"]], ["/app.css", ["app.css", "text/css"]],
    ["/demo", ["demo.html", "text/html"]], ["/demo.mjs", ["demo.mjs", "text/javascript"]], ["/sdk.mjs", ["sdk.mjs", "text/javascript"]]]);
  const server = createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff"); response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      if (!ready) { sendJSON(response, 503, { error: { code: "starting", message: "Hub is starting" } }); return; }
      if (maintenanceFailure) { sendJSON(response, 503, { error: { code: "storage_unavailable", message: "Hub storage maintenance failed; existing state is retained" } }); return; }
      if (request.headers.host !== new URL(origin).host) throw new PloopError("forbidden", "Host does not match this loopback Hub");
      const url = new URL(request.url, origin), path = url.pathname, callerOrigin = request.headers.origin;
      const publicRoute = path === "/api/feedback" || /^\/api\/receipts\//.test(path);
      if (callerOrigin && callerOrigin !== origin && path !== "/sdk.mjs") {
        if (!publicRoute || !store.projects().some((p) => p.config.origins.includes(callerOrigin))) throw new PloopError("forbidden", "Origin is not allowed");
        response.setHeader("access-control-allow-origin", callerOrigin); response.setHeader("vary", "Origin");
      }
      if (request.method === "OPTIONS" && publicRoute) {
        response.setHeader("access-control-allow-methods", "GET, POST"); response.setHeader("access-control-allow-headers", "authorization,content-type,idempotency-key,x-ploop-receipt-key");
        response.writeHead(204); response.end(); return;
      }
      if (request.method === "GET" && assets.has(path)) {
        const [name, type] = assets.get(path);
        if (path === "/sdk.mjs") response.setHeader("access-control-allow-origin", "*");
        response.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" }); response.end(await readFile(join(projectRoot, "public", name))); return;
      }
      if (request.method === "GET" && path === "/api/demo") {
        const id = store.meta("demo_project");
        if (!id) throw new PloopError("not_found", "Demo is not configured");
        const p = store.project(id); sendJSON(response, 200, { projectId: id, projectKey: p.publicKey, appVersion: "orders-demo-seeded-bug" }); return;
      }
      if (request.method === "GET" && path === "/demo/export-orders.mjs") {
        const id = store.meta("demo_project"); if (!id) throw new PloopError("not_found", "Demo is not configured");
        const p = store.project(id);
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }); response.end(await readFile(join(p.config.repository, "src/export-orders.mjs"))); return;
      }
      if (request.method === "POST" && path === "/api/feedback") {
        const p = store.projectByKey(bearer(request, "Ingest"));
        if (callerOrigin && callerOrigin !== origin && !p.config.origins.includes(callerOrigin)) throw new PloopError("forbidden", "Origin is not allowed for this project");
        const raw = await readRequest(request, 64 * 1024);
        sendJSON(response, 201, store.ingest(p.id, request.headers["idempotency-key"], request.headers["x-ploop-receipt-key"], raw)); return;
      }
      const receipt = path.match(/^\/api\/receipts\/([a-zA-Z0-9_-]+)$/);
      if (request.method === "GET" && receipt) { sendJSON(response, 200, store.receipt(receipt[1], bearer(request, "Receipt"))); return; }
      if (path.startsWith("/api/bridge/")) {
        const device = store.deviceByToken(bearer(request));
        if (request.method !== "POST") throw new PloopError("not_found", "Unknown Bridge operation");
        const input = object(parseJSON(await readRequest(request, path.endsWith("/finish") ? 4 * 1024 * 1024 : 256 * 1024)));
        if (path === "/api/bridge/claim") {
          const assignment = store.claim(device.id, input.claimId);
          if (!assignment) { response.writeHead(204); response.end(); } else sendJSON(response, 200, assignment);
        } else if (path === "/api/bridge/heartbeat") sendJSON(response, 200, store.heartbeat(device.id, input.active == null ? null : assignmentInput(input.active)));
        else if (path === "/api/bridge/progress") { store.progress(device.id, assignmentInput(input.assignment), identifier(input.eventId), text(input.type, "event type", 100), object(input.data)); sendJSON(response, 200, { acknowledged: true }); }
        else if (path === "/api/bridge/finish") {
          const task = store.finish(device.id, assignmentInput(input.assignment), identifier(input.eventId), input.report);
          sendJSON(response, 200, { acknowledged: true, id: task.id, state: task.state });
        }
        else if (path === "/api/bridge/recover") { store.recover(device.id, assignmentInput(input.assignment), text(input.reason, "reason"), identifier(input.eventId)); sendJSON(response, 200, { acknowledged: true }); }
        else throw new PloopError("not_found", "Unknown Bridge operation");
        return;
      }
      if (!equalSecret(bearer(request), secrets.adminToken)) throw new PloopError("unauthorized", "Enter the local Hub admin key");
      if (request.method === "GET" && path === "/api/status") { sendJSON(response, 200, { version: "0.1.0-local", counts: store.summary(), devices: store.devices(), localOnly: true }); return; }
      if (request.method === "GET" && path === "/api/projects") { sendJSON(response, 200, { items: store.projects() }); return; }
      if (request.method === "POST" && path === "/api/projects") {
        const config = await bindProject(parseJSON(await readRequest(request, 64 * 1024))); sendJSON(response, 201, store.addProject(config)); return;
      }
      if (request.method === "GET" && path === "/api/tasks") {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new PloopError("invalid_request", "limit must be 1–100");
        let before;
        if (url.searchParams.has("cursor")) {
          before = object(parseJSON(Buffer.from(url.searchParams.get("cursor"), "base64url").toString("utf8")));
          if (!Number.isSafeInteger(before.createdAt)) throw new PloopError("invalid_request", "Invalid cursor"); identifier(before.id);
        }
        const page = store.tasks({ before, limit });
        sendJSON(response, 200, { ...page, nextCursor: page.nextCursor ? Buffer.from(JSON.stringify(page.nextCursor)).toString("base64url") : null }); return;
      }
      const task = path.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)(?:\/(approve|cancel|patch))?$/);
      if (task) {
        const [, id, operation] = task;
        if (request.method === "GET" && !operation) { sendJSON(response, 200, store.task(id)); return; }
        if (request.method === "POST" && operation === "approve") {
          const existing = store.task(id), p = store.project(existing.projectId);
          sendJSON(response, 200, store.approve(id, await snapshotProject(p.config))); return;
        }
        if (request.method === "POST" && operation === "cancel") { sendJSON(response, 200, store.cancel(id)); return; }
        if (request.method === "GET" && operation === "patch") {
          const result = store.task(id).result;
          if (typeof result?.patch !== "string" || sha256(result.patch) !== result.patchSha256) throw new PloopError("not_found", "No verified patch is available");
          response.writeHead(200, { "content-type": "text/x-diff; charset=utf-8", "content-disposition": `attachment; filename="ploop-${id}.patch"`, "cache-control": "no-store" }); response.end(result.patch); return;
        }
      }
      throw new PloopError("not_found", "Route not found");
    } catch (error) {
      if (!response.headersSent) {
        if (error.code === "payload_capacity") response.setHeader("connection", "close");
        sendJSON(response, statusFor(error.code), { error: { code: error.code ?? "internal", message: error.code ? error.message : "Hub operation failed" } });
      }
      else response.destroy();
    }
  });
  server.requestTimeout = 15_000;
  try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }); }
  catch (error) { store.close(); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  try {
    if (!store.meta("local_device")) {
      const path = join(directory, "bridge.json");
      let existing;
      try { existing = parseJSON(await readFile(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (existing) {
        if (existing.schemaVersion !== 1 || existing.kind !== "ploop-bridge-connection" || typeof existing.token !== "string" || existing.token.length < 32) throw new PloopError("configuration_invalid", "Existing local Bridge connection has an unknown format");
        const device = store.deviceByToken(existing.token);
        if (existing.deviceId !== device.id) throw new PloopError("configuration_invalid", "Existing local Bridge identity is inconsistent");
        store.meta("local_device", device.id);
      } else {
        const device = store.addDevice("Local Bridge");
        await writeFile(path, JSON.stringify({ schemaVersion: 1, kind: "ploop-bridge-connection", deviceId: device.id, token: device.token }), { mode: 0o600, flag: "wx" });
        store.meta("local_device", device.id);
      }
    }
    if (demo && !store.meta("demo_project")) {
      const repository = join(directory, "demo-repository"), marker = join(directory, "demo-owner.json");
      const exists = await stat(repository).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
      if (!exists) { await writeFile(marker, JSON.stringify({ kind: "ploop-demo", repository }), { flag: "wx", mode: 0o600 }); await seedRepository(repository); }
      else if (parseJSON(await readFile(marker, "utf8")).repository !== repository) throw new PloopError("configuration_invalid", "Existing demo repository ownership is unknown");
      store.meta("demo_project", store.addProject(await bindDemo(repository, [origin])).id);
    }
    ready = true;
  } catch (error) { await new Promise((resolve) => server.close(resolve)); store.close(); throw error; }
  const expiry = setInterval(() => { try { store.expire(); maintenanceFailure = false; } catch { maintenanceFailure = true; } }, Math.min(1000, leaseMs)); expiry.unref();
  let closing;
  return { url: origin, directory, store, adminToken: secrets.adminToken, connectionFile: join(directory, "bridge.json"),
    close: () => closing ??= (async () => { clearInterval(expiry); await new Promise((resolve) => server.close(resolve)); store.close(); })() };
}
