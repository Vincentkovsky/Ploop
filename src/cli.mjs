#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { command } from "./runtime.mjs";
import { CodexRpc } from "./codex-rpc.mjs";
import { runPoc } from "./poc.mjs";
import { join } from "node:path";
import { projectRoot } from "./paths.mjs";

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  codex: { type: "string" }, model: { type: "string" }, timeout: { type: "string" }, "data-dir": { type: "string" }, feedback: { type: "string" }, help: { type: "boolean" },
  port: { type: "string" }, hub: { type: "string" }, connection: { type: "string" }, empty: { type: "boolean" }
} });
const action = values.help ? "help" : positionals[0] ?? "help";
const executable = values.codex ?? process.env.PLOOP_CODEX_BIN ?? "codex";
const controller = new AbortController();
let interrupted = false;
const stop = () => { interrupted = true; controller.abort(); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);

try {
  if (["hub", "bridge", "dev"].includes(action)) {
    const timeoutMs = values.timeout === undefined ? 180_000 : Number(values.timeout);
    const port = values.port === undefined ? 4317 : Number(values.port);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 2_147_483_647 || !Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Port must be 0–65535; timeout must be 1000–2147483647 milliseconds");
    const { runBridge } = await import("./bridge.mjs");
    let hub;
    try {
      if (action !== "bridge") {
        const { startHub } = await import("./hub.mjs");
        const base = values["data-dir"] ? resolve(values["data-dir"]) : join(projectRoot, ".ploop");
        hub = await startHub({ directory: action === "dev" ? join(base, "hub") : (values["data-dir"] ? base : join(base, "hub")), port, demo: !values.empty });
        console.log(`Ploop Hub: ${hub.url}\nAdmin key file: ${join(hub.directory, "secrets.json")}\nFeedback demo: ${hub.url}/demo`);
      }
      if (action === "hub") {
        await new Promise((resolve) => { if (controller.signal.aborted) resolve(); else controller.signal.addEventListener("abort", resolve, { once: true }); });
      } else {
        const data = values["data-dir"] ? resolve(values["data-dir"]) : join(projectRoot, ".ploop");
        const result = await runBridge({ hub: hub?.url ?? values.hub, connectionFile: hub?.connectionFile ?? (values.connection ? resolve(values.connection) : undefined),
          directory: action === "dev" ? join(data, "bridge") : (values["data-dir"] ? data : join(data, "bridge")),
          executable, model: values.model, timeoutMs, signal: controller.signal,
          onProgress: (state, data) => console.log(`[Bridge ${state}] ${JSON.stringify(data)}`) });
        if (result.state === "recovery_required") process.exitCode = 2;
      }
    } finally { if (hub) await hub.close(); }
  } else if (action === "doctor") {
    const version = await command(executable, ["--version"]);
    if (version.code !== 0) throw new Error("Cannot read Codex version");
    const rpc = new CodexRpc({ executable, cwd: process.cwd() });
    try {
      const handshake = await rpc.initialize();
      const auth = await rpc.request("account/read", { refreshToken: false });
      const models = await rpc.request("model/list", { limit: 20 });
      console.log(JSON.stringify({ node: process.version, codex: version.stdout.trim(), platform: handshake.platformOs,
        auth: { type: auth.account?.type ?? null, requiresOpenaiAuth: auth.requiresOpenaiAuth },
        models: models.data?.map(({ id, model, isDefault }) => ({ id, model, isDefault })),
        inferenceVerified: false }, null, 2));
    } finally { await rpc.close(); }
  } else if (action === "run") {
    const timeoutMs = values.timeout === undefined ? undefined : Number(values.timeout);
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 2_147_483_647)) throw new Error("--timeout must be 1000–2147483647 milliseconds");
    const report = await runPoc({ executable, model: values.model, timeoutMs,
      dataRoot: values["data-dir"] ? resolve(values["data-dir"]) : undefined,
      feedbackPath: values.feedback ? resolve(values.feedback) : undefined,
      signal: controller.signal, onProgress: (status, data) => console.error(`[${new Date().toISOString()}] ${status} ${JSON.stringify(data)}`) });
    console.log(JSON.stringify({ id: report.id, status: report.status, directory: report.directory, baseCommit: report.baseCommit,
      candidateCommit: report.candidateCommit, baseline: report.baseline?.summary, verification: report.verification?.summary,
      metrics: report.metrics, error: report.error }, null, 2));
    if (report.status !== "verified") process.exitCode = report.status === "cancelled" ? 130 : 1;
  } else if (action === "report" && positionals[1]) {
    console.log(await readFile(resolve(positionals[1], "report.json"), "utf8"));
  } else {
    console.log("Ploop local MVP\n\nnpm start -- [--port 4317] [--data-dir DIRECTORY] [--empty]\nnpm run hub -- [--port 4317] [--data-dir HUB_DIRECTORY] [--empty]\nnpm run bridge -- [--hub http://127.0.0.1:4317] [--connection FILE] [--data-dir BRIDGE_DIRECTORY]\nnpm run doctor -- [--codex PATH]\nnpm run poc -- [--codex PATH] [--model MODEL] [--timeout MILLISECONDS]\nnode src/cli.mjs report RUN_DIRECTORY\n\nThe Hub listens on loopback only. New feedback requires explicit admin approval. Bridge / dev accept --codex, --model and --timeout. Model calls consume your selected provider's usage. Verified patches are retained locally; publication is manual. See docs/本地MVP.md.");
    if (action !== "help" || values.help === false) process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? "error", message: error.message, details: error.details ?? {} }));
  process.exitCode = interrupted ? 130 : 1;
} finally {
  process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
}
