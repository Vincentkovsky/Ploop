import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, appendFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, parseFeedback, readFeedbackBytes } from "../src/runtime.mjs";
import { CodexRpc, parseMessage, runCodex } from "../src/codex-rpc.mjs";
import { freezeCandidate, runPoc, seedRepository, tapSummary, verifyCommit } from "../src/poc.mjs";

const fake = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
await chmod(fake, 0o755);
const temporary = async (t) => {
  const path = await mkdtemp(join(tmpdir(), "ploop-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
};

test("feedback rejects unsupported versions and malformed context before execution", async () => {
  const feedback = JSON.parse(await readFile(new URL("../examples/orders/feedback.json", import.meta.url)));
  assert.equal(parseFeedback(feedback), feedback);
  for (const value of [null, [], { ...feedback, schemaVersion: 2 }, { ...feedback, title: "" }, { ...feedback, context: { observations: [3] } }])
    assert.throws(() => parseFeedback(value), { code: "invalid_feedback" });
});

test("feedback input is rejected at the byte budget before parsing or execution", async (t) => {
  const root = await temporary(t), path = join(root, "feedback.json");
  await writeFile(path, Buffer.alloc(65_537, 32));
  await assert.rejects(() => readFeedbackBytes(path), { code: "feedback_capacity" });
});

test("JSON-RPC parser distinguishes requests, responses and malformed messages", () => {
  assert.equal(parseMessage('{"method":"ready"}').kind, "notification");
  assert.equal(parseMessage('{"id":1,"result":{}}').kind, "response");
  assert.equal(parseMessage('{"id":1,"method":"ask"}').kind, "request");
  for (const line of ["null", "[]", "broken", '{"id":1,"result":{},"error":{}}'])
    assert.throws(() => parseMessage(line), { code: "protocol_invalid" });
});

test("a completed turn arriving before the turn/start response is retained", async (t) => {
  const cwd = await temporary(t);
  const result = await runCodex({ executable: fake, cwd, task: "fixture" });
  assert.equal(result.status, "completed");
  assert.equal(result.turnId, "fixture-turn");
  assert.equal(result.tokenUsage.total.totalTokens, 13);
});

test("protocol cancellation waits for an interrupted terminal turn", async (t) => {
  const cwd = await temporary(t), controller = new AbortController();
  let timer, closed;
  try {
    await assert.rejects(() => runCodex({ executable: fake, cwd, task: "WAIT_FOR_CANCELLATION", signal: controller.signal,
      onEvent: (type, data) => {
        if (type === "agent.started") timer = setTimeout(() => controller.abort(), 50);
        if (type === "agent.closed") closed = data;
      } }), { code: "cancelled" });
    assert.equal(closed.turnStatus, "interrupted");
  } finally { clearTimeout(timer); }
});

test("malformed RPC output rejects its pending caller and still closes the child", async (t) => {
  const rpc = new CodexRpc({ executable: fake, cwd: await temporary(t) });
  try {
    await rpc.initialize();
    await assert.rejects(() => rpc.request("fixture/malformed"), { code: "protocol_invalid" });
  } finally { await rpc.close(); }
  assert.equal(rpc.closed, true);
});

test("baseline runs all eight acceptance checks and reproduces the seeded bug", async (t) => {
  const root = await temporary(t), repository = join(root, "repository");
  const commit = await seedRepository(repository);
  const result = await verifyCommit({ repository, commit, directory: join(root, "snapshot") });
  assert.equal(result.code, 1);
  assert.deepEqual(result.summary, { tests: 8, pass: 3, fail: 5, cancelled: 0, skipped: 0 });
  assert.equal(result.commit, commit);
  assert.equal(result.acceptanceSha256.length, 64);
});

test("owner-controlled verification rejects source mutated during testing", async (t) => {
  const root = await temporary(t), repository = join(root, "repository");
  await seedRepository(repository);
  await appendFile(join(repository, "src/export-orders.mjs"), '\nimport { appendFileSync } from "node:fs"; appendFileSync(new URL(import.meta.url), "\\n// changed during verification\\n");\n');
  await git(repository, ["add", "--", "src/export-orders.mjs"]);
  await git(repository, ["-c", "commit.gpgsign=false", "commit", "-m", "test: mutate source during verification"]);
  const commit = await git(repository, ["rev-parse", "HEAD"]);
  await assert.rejects(() => verifyCommit({ repository, commit, directory: join(root, "snapshot") }), { code: "verification_changed" });
});

test("candidate freezing rejects edits outside the authorized source file", async (t) => {
  const root = await temporary(t), repository = join(root, "repository");
  const baseCommit = await seedRepository(repository);
  await appendFile(join(repository, "README.md"), "\nAgent modified the acceptance instructions.\n");
  await assert.rejects(() => freezeCandidate({ worktree: repository, baseCommit }), { code: "unauthorized_changes" });
});

test("an Agent saying success without a fix cannot produce a verified result", async (t) => {
  const root = await temporary(t);
  const report = await runPoc({ dataRoot: root, executable: fake });
  assert.equal(report.status, "failed");
  assert.equal(report.error.code, "unauthorized_changes");
  assert.equal(report.verification, undefined);
  const saved = JSON.parse(await readFile(join(report.directory, "report.json"), "utf8"));
  assert.equal(saved.status, "failed");
  assert.equal(saved.agent.status, "completed");
});

test("TAP summary does not turn missing coverage into zero failures", () => {
  assert.equal(tapSummary("not a completed TAP run").fail, null);
});
