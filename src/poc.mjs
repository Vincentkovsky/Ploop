import { cp, mkdir, readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Journal, PloopError, command, git, parseFeedback, readFeedbackBytes, sha256, writeJSON } from "./runtime.mjs";
import { runCodex } from "./codex-rpc.mjs";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const acceptancePath = join(projectRoot, "acceptance/orders.test.mjs");

export function tapSummary(output) {
  const get = (name) => {
    const match = output.match(new RegExp(`^# ${name} (\\d+)\\s*$`, "m"));
    return match ? Number(match[1]) : null;
  };
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
  await visit("");
  return { files, sha256: sha256(JSON.stringify(files)) };
}

export async function verifyCommit({ repository, commit, directory, signal }) {
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new PloopError("invalid_commit", "Verification requires a full commit identity");
  await mkdir(directory, { mode: 0o700 });
  const archive = `${directory}.tar`;
  await git(repository, ["archive", "--format=tar", `--output=${archive}`, commit], { signal });
  const extraction = await command("tar", ["-xf", archive, "-C", directory], { signal });
  if (extraction.code !== 0) throw new PloopError("snapshot_failed", "Failed to export verification snapshot");
  const before = await treeDigest(directory);
  const harnessBytes = await readFile(acceptancePath);
  const result = await command(process.execPath, ["--test", "--test-reporter=tap", acceptancePath], {
    cwd: directory, signal,
    env: { PATH: process.env.PATH, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), PLOOP_TARGET: directory }
  });
  const after = await treeDigest(directory);
  if (before.sha256 !== after.sha256 || sha256(await readFile(acceptancePath)) !== sha256(harnessBytes))
    throw new PloopError("verification_changed", "Source snapshot or owner-controlled acceptance changed during verification");
  const summary = tapSummary(result.stdout);
  if (summary.tests !== 8 || summary.cancelled !== 0 || summary.skipped !== 0 || summary.pass + summary.fail !== summary.tests)
    throw new PloopError("verification_incomplete", "Acceptance did not complete all eight checks", { summary, exitCode: result.code });
  return { commit, snapshotSha256: before.sha256, acceptanceSha256: sha256(harnessBytes), summary, ...result };
}

export async function seedRepository(directory) {
  await cp(join(projectRoot, "examples/orders"), directory, { recursive: true, errorOnExist: true, force: false });
  await git(directory, ["init", "--initial-branch=main"]);
  await git(directory, ["config", "user.name", "Ploop PoC"]);
  await git(directory, ["config", "user.email", "poc@ploop.invalid"]);
  await git(directory, ["add", "--", "."]);
  await git(directory, ["-c", "commit.gpgsign=false", "commit", "-m", "test: seed order export pagination bug"]);
  return git(directory, ["rev-parse", "HEAD"]);
}

export async function freezeCandidate({ worktree, baseCommit, signal }) {
  if (await git(worktree, ["rev-parse", "HEAD"]) !== baseCommit) throw new PloopError("agent_git_changed", "Agent changed Git history");
  const file = await lstat(join(worktree, "src/export-orders.mjs"));
  if (!file.isFile() || (file.mode & 0o111) !== 0) throw new PloopError("unauthorized_changes", "Candidate source must remain a regular non-executable file");
  if (file.size > 1_048_576) throw new PloopError("source_capacity", "Candidate exceeded the PoC's in-memory source budget");
  const untracked = await git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"], { raw: true });
  const changed = await git(worktree, ["diff", "--name-only", "--no-renames", "-z", baseCommit], { raw: true });
  const paths = changed.split("\0").filter(Boolean);
  if (untracked || paths.length !== 1 || paths[0] !== "src/export-orders.mjs")
    throw new PloopError("unauthorized_changes", "Expected a change only to src/export-orders.mjs", { paths, untracked: untracked.split("\0").filter(Boolean) });
  await git(worktree, ["add", "--", "src/export-orders.mjs"], { signal });
  await git(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", "fix: export every page of orders"], { signal });
  return git(worktree, ["rev-parse", "HEAD"], { signal });
}

export async function runPoc({ dataRoot = join(projectRoot, ".ploop/runs"), feedbackPath = join(projectRoot, "examples/orders/feedback.json"), executable = "codex", model, timeoutMs = 180_000, signal, onProgress = () => {} } = {}) {
  // The trusted caller chooses the fixture and executable. Feedback never chooses paths or commands.
  const rawFeedback = await readFeedbackBytes(feedbackPath);
  let feedback;
  try { feedback = parseFeedback(JSON.parse(rawFeedback)); }
  catch (error) { if (error instanceof PloopError) throw error; throw new PloopError("invalid_feedback", "Feedback is not valid JSON"); }
  const id = randomUUID();
  await mkdir(resolve(dataRoot), { recursive: true, mode: 0o700 });
  const directory = join(resolve(dataRoot), id);
  await mkdir(directory, { mode: 0o700 });
  const started = performance.now();
  const journal = new Journal(directory);
  const repository = join(directory, "repository"), worktree = join(directory, "worktree");
  const report = { schemaVersion: 1, id, directory, repository, worktree, status: "preparing", startedAt: new Date().toISOString(),
    feedback: { title: feedback.title, source: "synthetic seeded bug report", sha256: sha256(rawFeedback) },
    runtime: { node: process.version, platform: process.platform, arch: process.arch, codexExecutable: executable },
    metrics: { elapsedMs: null, agentElapsedMs: null, tokenUsage: null, cpuMs: null, peakProcessFamilyMemoryBytes: null, actualCost: null },
    limitations: ["Synthetic feedback and intentionally seeded example bug", "No Hub, SDK or durable distributed queue yet", "No claim of credential/read isolation from workspace-write", "No automatic publication; remote PR is a separate maintainer operation", "CPU, process-family peak memory and actual cost are unmeasured", "Run directories are retained; automatic recovery/resume is not implemented"] };
  const save = () => writeJSON(join(directory, "report.json"), report);
  let journalFailure;
  const record = (type, data = {}) => {
    const result = journal.append(type, data);
    result.catch((error) => { journalFailure ??= error; });
    return result;
  };
  const stage = async (status, data = {}) => {
    if (signal?.aborted) throw new PloopError("cancelled", "PoC cancelled");
    report.status = status; await record(`run.${status}`, data); await save(); onProgress(status, data);
  };
  try {
    await writeFile(join(directory, "feedback-source.json"), rawFeedback, { mode: 0o600, flag: "wx" });
    await save();
    report.baseCommit = await seedRepository(repository);
    report.branch = `codex/fix-orders-${id.slice(0, 8)}`;
    await git(repository, ["worktree", "add", "-b", report.branch, worktree, report.baseCommit], { signal });
    await stage("baseline");
    report.baseline = await verifyCommit({ repository, commit: report.baseCommit, directory: join(directory, "baseline"), signal });
    if (report.baseline.code !== 1 || report.baseline.summary.fail < 1) throw new PloopError("bug_not_reproduced", "Expected completed, failing baseline acceptance");
    await record("verification.baseline", { commit: report.baseCommit, summary: report.baseline.summary });
    await stage("running", { baseline: report.baseline.summary });
    const agentStarted = performance.now();
    try {
      report.agent = await runCodex({ executable, cwd: worktree, model, timeoutMs, signal,
        task: `Fix the order export bug described below. Read the existing source and preserve its public API and CSV behavior. Change only src/export-orders.mjs. Do not change Git history or create commits. The external orchestrator owns verification and publication.\n\n<external_feedback_json>\n${JSON.stringify(feedback, null, 2)}\n</external_feedback_json>`,
        onEvent: (type, data) => {
          if (type === "agent.usage") report.metrics.tokenUsage = data.tokenUsage;
          void record(type, data);
          if (type === "agent.started") onProgress(type, data);
        } });
    } finally { report.metrics.agentElapsedMs = Math.round(performance.now() - agentStarted); }
    if (journalFailure) throw journalFailure;
    await stage("freezing");
    report.candidateCommit = await freezeCandidate({ worktree, baseCommit: report.baseCommit, signal });
    await stage("verifying", { commit: report.candidateCommit });
    report.verification = await verifyCommit({ repository, commit: report.candidateCommit, directory: join(directory, "verified"), signal });
    if (report.verification.code !== 0 || report.verification.summary.fail !== 0)
      throw new PloopError("verification_failed", "Candidate failed independent acceptance", { summary: report.verification.summary });
    const patch = await git(repository, ["diff", "--binary", report.baseCommit, report.candidateCommit], { raw: true });
    await writeFile(join(directory, "fix.patch"), patch, { mode: 0o600, flag: "wx" });
    report.patchSha256 = sha256(patch);
    await record("verification.passed", { commit: report.candidateCommit, summary: report.verification.summary });
    await stage("verified", { commit: report.candidateCommit, tests: report.verification.summary });
  } catch (error) {
    report.status = error.code === "cancelled" ? "cancelled" : "failed";
    report.error = { code: error.code ?? "unexpected", message: error.message, details: error.details ?? {} };
    await record(`run.${report.status}`, report.error);
    onProgress(report.status, report.error);
  } finally {
    report.finishedAt = new Date().toISOString(); report.metrics.elapsedMs = Math.round(performance.now() - started);
    await journal.tail;
    await save();
  }
  return report;
}
