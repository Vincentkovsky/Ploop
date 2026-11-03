import { PloopError } from "./runtime.mjs";

export async function readRequest(request, maxBytes) {
  const chunks = []; let size = 0;
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw new PloopError("payload_capacity", `Request exceeded its ${maxBytes} byte budget`);
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => { if (settled) return; settled = true; if (error) reject(error); else resolve(); };
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { request.pause(); finish(new PloopError("payload_capacity", `Request exceeded its ${maxBytes} byte budget`)); }
      else chunks.push(chunk);
    });
    request.once("end", () => finish()); request.once("error", (error) => finish(error)); request.once("aborted", () => finish(new PloopError("request_aborted", "Request upload did not complete")));
  });
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new PloopError("invalid_request", "Request must be valid UTF-8"); }
}
export function parseJSON(raw) {
  try { return JSON.parse(raw); } catch { throw new PloopError("invalid_request", "Request is not valid JSON"); }
}
export function sendJSON(response, status, data) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(data));
}
export function bearer(request, scheme = "Bearer") {
  const value = request.headers.authorization;
  return typeof value === "string" && value.startsWith(`${scheme} `) ? value.slice(scheme.length + 1) : "";
}
export const statusFor = (code) => ({ not_found: 404, unauthorized: 401, forbidden: 403, conflict: 409, repository_dirty: 409,
  repository_changed: 409, acceptance_changed: 409, payload_capacity: 413, invalid_request: 400, invalid_feedback: 400 }[code] ?? 500);

export class HubClient {
  constructor(url, credential, { timeoutMs = 4000 } = {}) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new PloopError("invalid_request", "Invalid Hub URL"); }
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/")
      throw new PloopError("invalid_request", "This local MVP accepts only an HTTP 127.0.0.1 Hub origin");
    this.url = parsed.origin; this.credential = credential; this.timeoutMs = timeoutMs;
  }
  async request(path, body) {
    let response;
    try { response = await fetch(`${this.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${this.credential}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) }); }
    catch { throw new PloopError("hub_unreachable", "Hub is unavailable; local state and outbox are retained"); }
    if (response.status === 204) return null;
    const chunks = []; let length = 0;
    try {
      for await (const bytes of response.body) {
        length += bytes.length;
        if (length > 4 * 1024 * 1024) throw new PloopError("payload_capacity", "Hub response exceeded its memory budget");
        chunks.push(bytes);
      }
    } catch (error) {
      if (error instanceof PloopError) throw error;
      throw new PloopError("hub_unreachable", "Hub response did not finish; local outbox is retained");
    }
    if (response.status >= 500) throw new PloopError("hub_unreachable", "Hub is temporarily unable to acknowledge this operation");
    const result = parseJSON(Buffer.concat(chunks).toString("utf8"));
    if (!response.ok) throw new PloopError(result.error?.code ?? "hub_error", result.error?.message ?? "Hub request failed", { status: response.status });
    return result;
  }
}
