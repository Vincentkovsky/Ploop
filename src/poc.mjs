import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readFeedbackBytes } from "./runtime.mjs";
import { feedbackSource } from "./contracts.mjs";
import { projectRoot } from "./paths.mjs";
import { seedRepository, bindDemo } from "./demo.mjs";
import { snapshotProject } from "./projects.mjs";
import { executeTask } from "./execution.mjs";

export async function runPoc({ dataRoot = join(projectRoot, ".ploop/runs"), feedbackPath = join(projectRoot, "examples/orders/feedback.json"), executable = "codex", model, timeoutMs = 180_000, signal, onProgress = () => {} } = {}) {
  const raw = await readFeedbackBytes(feedbackPath);
  const feedback = feedbackSource(raw);
  const id = randomUUID(), directory = join(resolve(dataRoot), id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const repository = join(directory, "repository");
  await seedRepository(repository);
  const snapshot = await snapshotProject(await bindDemo(repository));
  return executeTask({ id, directory, snapshot, feedbackRaw: feedback.source, executable, model, timeoutMs, signal,
    onEvent: (type, data) => { if (type === "execution.phase") onProgress(data.phase, data); else if (type === "agent.started") onProgress(type, data); } });
}
