#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { command } from "./runtime.mjs";
import { CodexRpc } from "./codex-rpc.mjs";
import { runPoc } from "./poc.mjs";

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  codex: { type: "string" }, model: { type: "string" }, timeout: { type: "string" }, "data-dir": { type: "string" }, feedback: { type: "string" }, help: { type: "boolean" }
} });
const action = values.help ? "help" : positionals[0] ?? "help";
const executable = values.codex ?? process.env.PLOOP_CODEX_BIN ?? "codex";
const controller = new AbortController();
let interrupted = false;
const stop = () => { interrupted = true; controller.abort(); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);

try {
  if (action === "doctor") {
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
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000)) throw new Error("--timeout must be milliseconds >= 1000");
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
    console.log("Ploop M0 PoC (not a production service)\n\nnode src/cli.mjs doctor [--codex PATH]\nnode src/cli.mjs run [--codex PATH] [--model MODEL] [--timeout MILLISECONDS]\nnode src/cli.mjs report RUN_DIRECTORY\n\nRuns use synthetic feedback, a fresh owned Git repository and an external acceptance suite. Model calls consume your selected provider's usage. No remote publication is performed by this command.");
    if (action !== "help" || values.help === false) process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? "error", message: error.message, details: error.details ?? {} }));
  process.exitCode = interrupted ? 130 : 1;
} finally {
  process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
}
