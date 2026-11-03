import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "../src/runtime.mjs";

test("command cancellation stops its live owned process group after a child starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ploop-command-")), marker = join(root, "ready");
  const controller = new AbortController();
  const childCode = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setTimeout(()=>{},5000)`;
  const running = command(process.execPath, ["-e", `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit'});setTimeout(()=>{},5000)`], { signal: controller.signal });
  running.catch(() => {});
  try {
    const deadline = Date.now() + 4000;
    while (!await readFile(marker, "utf8").then(() => true, () => false)) {
      assert.ok(Date.now() < deadline, "Owned descendant did not start");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort(); await assert.rejects(running, { code: "cancelled" });
  } finally { controller.abort(); await running.catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

test("leader exit with inherited pipes is retained as unknown cleanup, not success", async () => {
  try {
    await assert.rejects(() => command(process.execPath, ["-e", `require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{stdio:'inherit'});process.exit(0)`]), { code: "command_cleanup_unknown" });
  } finally { await new Promise((resolve) => setTimeout(resolve, 700)); }
});
