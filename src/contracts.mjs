import { PloopError } from "./runtime.mjs";

export function object(value, name = "request") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PloopError("invalid_request", `${name} must be an object`);
  return value;
}
export function text(value, name, max = 1000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new PloopError("invalid_request", `${name} must be a nonempty string of at most ${max} characters`);
  return value;
}
export function identifier(value, name = "id") {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(value)) throw new PloopError("invalid_request", `${name} is invalid`);
  return value;
}
export function projectInput(value) {
  object(value, "project");
  text(value.name, "name", 120); text(value.repository, "repository", 4096);
  if (!Array.isArray(value.allowedPaths) || value.allowedPaths.length < 1 || value.allowedPaths.length > 32)
    throw new PloopError("invalid_request", "allowedPaths must list 1–32 exact repository-relative files");
  for (const path of value.allowedPaths) {
    if (typeof path !== "string" || path.length > 4096 || path.includes("\\") || path.includes("\0") || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git"))
      throw new PloopError("invalid_request", "Allowed files must be exact relative paths without traversal");
  }
  if (new Set(value.allowedPaths).size !== value.allowedPaths.length) throw new PloopError("invalid_request", "Duplicate allowed files");
  const acceptance = object(value.acceptance, "acceptance");
  if (acceptance.baselineMustFail !== undefined && typeof acceptance.baselineMustFail !== "boolean") throw new PloopError("invalid_request", "baselineMustFail must be a boolean");
  if (!Array.isArray(acceptance.command) || acceptance.command.length < 1 || acceptance.command.length > 32 || acceptance.command.some((arg) => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0")))
    throw new PloopError("invalid_request", "acceptance.command must be an argv array");
  text(acceptance.command[0], "acceptance executable", 4096);
  if (!Number.isSafeInteger(acceptance.expectedTests) || acceptance.expectedTests < 1 || acceptance.expectedTests > 100_000)
    throw new PloopError("invalid_request", "expectedTests must identify the Node TAP coverage expected by the owner");
  if (!Array.isArray(acceptance.sourceFiles) || acceptance.sourceFiles.length < 1 || acceptance.sourceFiles.length > 32)
    throw new PloopError("invalid_request", "acceptance.sourceFiles must identify the owner-controlled verification files");
  for (const file of acceptance.sourceFiles) text(file, "acceptance source", 4096);
  const origins = value.origins ?? [];
  if (!Array.isArray(origins) || origins.length > 16) throw new PloopError("invalid_request", "origins must be an array");
  for (const origin of origins) {
    let url;
    try { url = new URL(origin); } catch { throw new PloopError("invalid_request", "Invalid origin"); }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) throw new PloopError("invalid_request", "Origins must be explicit HTTP origins");
  }
  return { name: value.name, repository: value.repository, allowedPaths: [...value.allowedPaths],
    acceptance: { command: [...acceptance.command], expectedTests: acceptance.expectedTests, sourceFiles: [...acceptance.sourceFiles], baselineMustFail: acceptance.baselineMustFail !== false }, origins };
}

export function feedbackInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 || value.kind !== "bug")
    throw new PloopError("invalid_feedback", "Expected a version 1 bug report");
  text(value.title, "title", 240); text(value.description, "description", 16_000); text(value.expected, "expected", 16_000);
  const context = value.context;
  if (!context || typeof context !== "object" || Array.isArray(context) || typeof context.appVersion !== "string" || typeof context.pagePath !== "string" || !Array.isArray(context.observations) || context.observations.some((item) => typeof item !== "string"))
    throw new PloopError("invalid_feedback", "Expected explicit appVersion, pagePath and observations");
  return value;
}
export function feedbackSource(raw) {
  let source, value;
  try { source = typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw); value = JSON.parse(source); }
  catch { throw new PloopError("invalid_feedback", "Feedback must be valid UTF-8 JSON"); }
  return { source, value: feedbackInput(value) };
}

export const terminalStates = new Set(["verified", "failed", "cancelled"]);
export function assignmentInput(value) {
  object(value, "assignment"); identifier(value.taskId, "taskId"); identifier(value.attemptId, "attemptId");
  if (!Number.isSafeInteger(value.generation) || value.generation < 1 || typeof value.leaseToken !== "string" || value.leaseToken.length < 32 || value.leaseToken.length > 128)
    throw new PloopError("invalid_request", "Assignment generation or lease credential is invalid");
  return value;
}
export function resultInput(value) {
  object(value, "result");
  if (value.schemaVersion !== 1 || !terminalStates.has(value.status)) throw new PloopError("invalid_request", "Expected a terminal version 1 execution result");
  if (value.status === "verified") {
    const summary = value.verification?.summary;
    if (!/^[a-f0-9]{40,64}$/.test(value.candidateCommit ?? "") || value.verification?.commit !== value.candidateCommit || value.verification?.code !== 0 ||
      !summary || !Number.isSafeInteger(summary.tests) || summary.tests < 1 || summary.pass !== summary.tests || summary.fail !== 0 || summary.cancelled !== 0 || summary.skipped !== 0)
      throw new PloopError("invalid_request", "Verified results require commit-bound completed acceptance");
  }
  return value;
}
