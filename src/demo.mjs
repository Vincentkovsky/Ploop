import { cp } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./runtime.mjs";
import { projectRoot, acceptancePath } from "./paths.mjs";
import { bindProject } from "./projects.mjs";
export async function seedRepository(directory) {
  await cp(join(projectRoot, "examples/orders"), directory, { recursive: true, errorOnExist: true, force: false });
  await git(directory, ["init", "--initial-branch=main"]);
  await git(directory, ["add", "--", "."]);
  await git(directory, ["-c", "user.name=Ploop", "-c", "user.email=poc@ploop.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "test: seed order export pagination bug"]);
  return git(directory, ["rev-parse", "HEAD"]);
}
export function bindDemo(repository, origins = []) {
  return bindProject({ name: "Order desk", repository, allowedPaths: ["src/export-orders.mjs"], origins,
    acceptance: { command: [process.execPath, "--test", "--test-reporter=tap", acceptancePath], sourceFiles: [acceptancePath], expectedTests: 8, baselineMustFail: true } });
}
