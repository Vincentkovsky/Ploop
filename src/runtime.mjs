import { spawn } from "node:child_process";
import { mkdir, open, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

export class PloopError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PloopError";
    this.code = code;
    this.details = details;
  }
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The PoC keeps a feedback document in memory; bound it before JSON expansion.
export async function readFeedbackBytes(path, maxBytes = 64 * 1024) {
  const file = await open(path, "r");
  const buffer = Buffer.alloc(maxBytes + 1);
  let length = 0;
  try {
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
  } finally { await file.close(); }
  if (length > maxBytes) throw new PloopError("feedback_capacity", "Feedback exceeded the PoC's 64 KiB input budget");
  return buffer.subarray(0, length);
}

export async function writeJSON(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally { await file.close(); }
  await rename(temporary, path);
}

export class Journal {
  constructor(directory) { this.directory = directory; this.sequence = 0; this.tail = Promise.resolve(); }
  append(type, data = {}) {
    const event = { sequence: ++this.sequence, at: new Date().toISOString(), type, data };
    this.tail = this.tail.then(async () => {
      const file = await open(join(this.directory, "events.jsonl"), "a", 0o600);
      try { await file.writeFile(`${JSON.stringify(event)}\n`); await file.sync(); }
      finally { await file.close(); }
    });
    return this.tail;
  }
}

// All commands are argv arrays. Child output has an explicit in-memory budget.
export function command(executable, args, { cwd, env = process.env, timeoutMs = 30_000, maxOutputBytes = 1_048_576, signal } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let child, stdout = [], stderr = [], bytes = 0, failure = null;
    let timer;
    const stop = (error) => {
      if (failure) return;
      failure = error;
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    try { child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { reject(error); return; }
    const collect = (list, chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) stop(new PloopError("output_limit", "Command output exceeded its memory budget"));
      else list.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.on("error", (error) => { failure = error; });
    const abort = () => stop(new PloopError("cancelled", "Command cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => stop(new PloopError("command_timeout", `Command exceeded ${timeoutMs}ms`)), timeoutMs);
    if (signal?.aborted) abort();
    child.on("close", (code, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failure) { reject(failure); return; }
      resolve({ executable, args, code, signal: exitSignal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), elapsedMs: Math.round(performance.now() - started) });
    });
  });
}

export async function git(cwd, args, options = {}) {
  const { raw = false, ...commandOptions } = options;
  const result = await command("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, ...commandOptions });
  if (result.code !== 0) throw new PloopError("git_failed", `git ${args[0]} failed`, { code: result.code, stderr: result.stderr });
  return raw ? result.stdout : result.stdout.trim();
}

export function parseFeedback(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 || value.kind !== "bug")
    throw new PloopError("invalid_feedback", "Expected a version 1 bug report");
  for (const field of ["title", "description", "expected"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) throw new PloopError("invalid_feedback", `${field} must be a nonempty string`);
  }
  const context = value.context;
  if (!context || typeof context !== "object" || Array.isArray(context) || typeof context.appVersion !== "string" || typeof context.pagePath !== "string" || !Array.isArray(context.observations) || context.observations.some((item) => typeof item !== "string"))
    throw new PloopError("invalid_feedback", "Expected explicit appVersion, pagePath and observations");
  return value;
}
