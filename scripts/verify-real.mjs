import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { runCodex } from "../src/codex-rpc.mjs";
import { command, sha256, writeJSON } from "../src/runtime.mjs";
import { projectRoot } from "../src/paths.mjs";

const root = join(projectRoot, ".ploop/verification", `native-${randomUUID()}`);
await mkdir(root, { recursive: true, mode: 0o700 });
const selected = process.argv[2] ?? "all";
if (!["all", "cancel", "timeout"].includes(selected)) throw new Error("Expected cancel, timeout or all");
const cases = [];
async function matchingProcesses(marker) {
  const result = await command("ps", ["-axo", "pid=,ppid=,command="], { maxOutputBytes: 2 * 1024 * 1024 });
  if (result.code !== 0) throw new Error("Process observation unavailable");
  return result.stdout.split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s+([\s\S]+)$/.exec(line)).filter(Boolean)
    .filter((match) => match[3].includes(marker) && /^\S*node\s/.test(match[3]))
    .map((match) => ({ pid: Number(match[1]), parentPid: Number(match[2]), commandSha256: sha256(match[3]) }));
}
for (const name of selected === "all" ? ["cancel", "timeout"] : [selected]) {
  const directory = join(root, name); await mkdir(directory); await writeFile(join(directory, "README.md"), "Owned temporary workspace for a real provider lifecycle check.\n");
  const marker = `ploop-${name}-${randomUUID()}`, controller = new AbortController();
  const result = { case: name, marker, model: null, startedAt: new Date().toISOString(), observedProcesses: [], closed: null, usage: null };
  const started = performance.now(); let observing = false, monitorFailure = null;
  const inspect = async () => {
    if (observing || result.observedProcesses.length) return;
    observing = true;
    try {
      const matches = await matchingProcesses(marker);
      if (matches.length) { result.observedProcesses = matches; result.commandObservedAt = new Date().toISOString(); console.log(`${name}: observed owned test command`); if (name === "cancel") controller.abort(); }
    } catch (error) { monitorFailure = error.message; }
    finally { observing = false; }
  };
  const interval = setInterval(() => void inspect(), 200);
  try {
    await runCodex({ executable: process.env.PLOOP_CODEX_BIN ?? "codex", cwd: directory, allowedPaths: [], signal: controller.signal, timeoutMs: name === "timeout" ? 30_000 : 90_000,
      task: `This is an authorized local cancellation/timeout test. Execute exactly one terminal command using this argv: ${JSON.stringify([process.execPath, "-e", "setTimeout(()=>{},60000)", "--", marker])}. It only waits and must not read or write files, use network, or start any other work. Do not shorten the wait. The external controller will stop the turn.`,
      onEvent: (type, data) => {
        if (type === "agent.started") { result.model = data.model; console.log(`${name}: real turn started`); }
        if (type === "agent.usage") result.usage = data.tokenUsage;
        if (type === "agent.closed") result.closed = data;
      } });
    result.error = { code: "unexpected_success", message: "The wait command was expected to be interrupted" };
  } catch (error) { result.error = { code: error.code ?? "unexpected", message: error.message, details: error.details ?? {} }; }
  finally { clearInterval(interval); }
  for (let attempt = 0; attempt < 10; attempt++) {
    result.remainingObservedProcesses = await matchingProcesses(marker);
    if (!result.remainingObservedProcesses.length) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  result.elapsedMs = Math.round(performance.now() - started); result.monitorFailure = monitorFailure;
  result.passed = result.error.code === (name === "cancel" ? "cancelled" : "agent_timeout") && result.closed?.turnStatus === "interrupted" && result.closed.code === 0 && result.closed.signal === null && result.remainingObservedProcesses.length === 0 && result.observedProcesses.length > 0;
  result.scope = "One real native-provider turn and an observed synthetic wait command; bounded process observation is not full host isolation proof";
  cases.push(result); await writeJSON(join(root, "report.json"), { schemaVersion: 1, cases });
  console.log(JSON.stringify({ case: name, passed: result.passed, elapsedMs: result.elapsedMs, error: result.error.code, closed: result.closed, commandObserved: result.observedProcesses.length > 0 }));
}
console.log(`Lifecycle evidence: ${root}`);
if (cases.some((result) => !result.passed)) process.exitCode = 1;
