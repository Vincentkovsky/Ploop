import { mkdir, readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Journal, PloopError, command, git, sha256, writeJSON } from "./runtime.mjs";
import { runCodex } from "./codex-rpc.mjs";
import { checkAcceptanceSources, checkRepositoryIdentity, inspectCommit } from "./projects.mjs";

export function tapSummary(output) {
  const get = (name) => { const match = output.match(new RegExp(`^# ${name} (\\d+)\\s*$`, "m")); return match ? Number(match[1]) : null; };
  return { tests: get("tests"), pass: get("pass"), fail: get("fail"), cancelled: get("cancelled"), skipped: get("skipped") };
}
export async function treeDigest(directory) {
  const files = [];
  const visit = async (relative) => {
    for (const entry of (await readdir(join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push({ path, sha256: sha256(await readFile(join(directory, path))) });
      else throw new PloopError("snapshot_unsupported", "Verification snapshots may only contain regular files", { path });
    }
  };
  await visit(""); return { files, sha256: sha256(JSON.stringify(files)) };
}
export async function verifyCommit({ repository, commit, directory, acceptance, signal }) {
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new PloopError("invalid_commit", "Verification requires a full commit identity");
  await checkAcceptanceSources(acceptance);
  await inspectCommit(repository, commit);
  await mkdir(directory, { mode: 0o700 });
  const archive = `${directory}.tar`;
  await git(repository, ["archive", "--format=tar", `--output=${archive}`, commit], { signal });
  const extraction = await command("tar", ["-xf", archive, "-C", directory], { signal });
  if (extraction.code !== 0) throw new PloopError("snapshot_failed", "Failed to export verification snapshot");
  const before = await treeDigest(directory), [executable, ...args] = acceptance.command;
  const result = await command(executable, args, { cwd: directory, signal,
    env: { PATH: process.env.PATH, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), PLOOP_TARGET: directory } });
  const after = await treeDigest(directory);
  await checkAcceptanceSources(acceptance);
  if (before.sha256 !== after.sha256) throw new PloopError("verification_changed", "Source snapshot changed during verification");
  const summary = tapSummary(result.stdout);
  if (summary.tests !== acceptance.expectedTests || summary.cancelled !== 0 || summary.skipped !== 0 || summary.pass + summary.fail !== summary.tests)
    throw new PloopError("verification_incomplete", "Acceptance did not complete the owner-declared coverage", { summary, exitCode: result.code });
  return { commit, snapshotSha256: before.sha256, acceptanceSha256: sha256(JSON.stringify(acceptance.sourceFiles)), summary, ...result };
}
export async function freezeCandidate({ worktree, baseCommit, allowedPaths, signal }) {
  if (await git(worktree, ["rev-parse", "HEAD"]) !== baseCommit) throw new PloopError("agent_git_changed", "Agent changed Git history");
  const untracked = await git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"], { raw: true });
  const changed = await git(worktree, ["diff", "--name-only", "--no-renames", "-z", baseCommit], { raw: true });
  const paths = changed.split("\0").filter(Boolean);
  if (untracked || !paths.length || paths.some((path) => !allowedPaths.includes(path)))
    throw new PloopError("unauthorized_changes", "Candidate must change only the owner-authorized files", { paths, untracked: untracked.split("\0").filter(Boolean) });
  for (const path of paths) {
    const file = await lstat(join(worktree, path));
    if (!file.isFile() || (file.mode & 0o111) !== 0) throw new PloopError("unauthorized_changes", "Candidate sources must remain regular non-executable files");
    if (file.size > 1_048_576) throw new PloopError("source_capacity", "Candidate exceeded the in-memory source budget");
  }
  await git(worktree, ["add", "--", ...paths], { signal });
  await git(worktree, ["-c", "user.name=Ploop", "-c", "user.email=poc@ploop.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fix: address approved feedback"], { signal });
  return git(worktree, ["rev-parse", "HEAD"], { signal });
}
export async function executeTask({ id, directory, snapshot, feedbackRaw, executable = "codex", model, timeoutMs = 180_000, signal, onEvent = () => {} }) {
  const { digest, ...snapshotBody } = snapshot;
  if (snapshot.schemaVersion !== 1 || digest !== sha256(JSON.stringify(snapshotBody))) throw new PloopError("snapshot_invalid", "Task snapshot version or digest is invalid");
  const { config, baseCommit } = snapshot;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "owner.json"), JSON.stringify({ id, projectDigest: snapshot.digest, baseCommit }), { flag: "wx", mode: 0o600 });
  const started = performance.now(), journal = new Journal(directory), worktree = join(directory, "worktree");
  const report = { schemaVersion: 1, id, directory, repository: config.repository, worktree, baseCommit, projectDigest: snapshot.digest,
    status: "preparing", startedAt: new Date().toISOString(), feedback: { sha256: sha256(feedbackRaw) },
    runtime: { node: process.version, platform: process.platform, arch: process.arch, codexExecutable: executable },
    metrics: { elapsedMs: null, agentElapsedMs: null, tokenUsage: null, cpuMs: null, peakProcessFamilyMemoryBytes: null, actualCost: null },
    limitations: ["Local trusted-repository execution; workspace-write is not complete host or credential isolation", "No automatic Git publication", "CPU, process-family peak memory and actual cost are unmeasured", "Run directories and unconfirmed executions are retained for inspection"] };
  let journalFailure;
  const record = (type, data = {}) => {
    const result = journal.append(type, data); result.catch((error) => { journalFailure ??= error; }); onEvent(type, data); return result;
  };
  const save = () => writeJSON(join(directory, "report.json"), report);
  const check = () => {
    if (signal?.aborted) throw signal.reason instanceof PloopError ? signal.reason : new PloopError("cancelled", "Execution cancelled");
    if (journalFailure) throw journalFailure;
  };
  const stage = async (phase, data = {}) => { check(); report.status = phase; await record("execution.phase", { phase, ...data }); await save(); };
  try {
    await writeFile(join(directory, "feedback-source.json"), feedbackRaw, { mode: 0o600, flag: "wx" });
    await save(); check(); await checkRepositoryIdentity(config); await inspectCommit(config.repository, baseCommit); await checkAcceptanceSources(config.acceptance, worktree);
    await git(config.repository, ["worktree", "add", "--detach", worktree, baseCommit], { signal });
    await stage("baseline");
    report.baseline = await verifyCommit({ repository: config.repository, commit: baseCommit, directory: join(directory, "baseline"), acceptance: config.acceptance, signal });
    if (config.acceptance.baselineMustFail && (report.baseline.code !== 1 || report.baseline.summary.fail < 1))
      throw new PloopError("bug_not_reproduced", "Expected completed, failing baseline acceptance");
    await record("verification.baseline", { commit: baseCommit, summary: report.baseline.summary }); await stage("running");
    const agentStarted = performance.now();
    try {
      report.agent = await runCodex({ executable, cwd: worktree, allowedPaths: config.allowedPaths, model, timeoutMs, signal,
        task: `Address the approved feedback below. Preserve behavior outside the requested change. Authorized files: ${JSON.stringify(config.allowedPaths)}. Do not change tests or Git history. The external verifier owns acceptance and publication.\n\n<external_feedback_json>\n${feedbackRaw}\n</external_feedback_json>`,
        onEvent: (type, data) => { if (type === "agent.usage") report.metrics.tokenUsage = data.tokenUsage; void record(type, data); } });
    } finally { report.metrics.agentElapsedMs = Math.round(performance.now() - agentStarted); }
    await stage("freezing"); report.candidateCommit = await freezeCandidate({ worktree, baseCommit, allowedPaths: config.allowedPaths, signal });
    await stage("verifying", { commit: report.candidateCommit });
    report.verification = await verifyCommit({ repository: config.repository, commit: report.candidateCommit, directory: join(directory, "verified"), acceptance: config.acceptance, signal });
    if (report.verification.code !== 0 || report.verification.summary.fail !== 0) throw new PloopError("verification_failed", "Candidate failed owner-controlled acceptance", { summary: report.verification.summary });
    check();
    const patch = await git(config.repository, ["diff", "--binary", baseCommit, report.candidateCommit], { raw: true });
    await writeFile(join(directory, "fix.patch"), patch, { mode: 0o600, flag: "wx" }); report.patchSha256 = sha256(patch);
    await record("verification.passed", { commit: report.candidateCommit, summary: report.verification.summary }); await stage("verified", { commit: report.candidateCommit });
  } catch (error) {
    report.status = ["cleanup_failed", "command_cleanup_unknown"].includes(error.code) ? "recovery_required" : error.code === "cancelled" ? "cancelled" : "failed";
    report.error = { code: error.code ?? "unexpected", message: error.message, details: error.details ?? {} };
    await record(`execution.${report.status}`, report.error);
  } finally {
    report.finishedAt = new Date().toISOString(); report.metrics.elapsedMs = Math.round(performance.now() - started); await journal.tail; await save();
  }
  return report;
}
