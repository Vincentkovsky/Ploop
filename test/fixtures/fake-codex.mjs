#!/usr/bin/env node
import readline from "node:readline";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let thread = "fixture-thread", turn = "fixture-turn";
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, "id")) continue;
  const { id, method, params } = message;
  if (method === "initialize") send({ id, result: { userAgent: "fake", platformOs: process.platform } });
  else if (method === "thread/start") send({ id, result: { thread: { id: thread }, model: "fixture-only" } });
  else if (method === "turn/start") {
    send({ method: "turn/started", params: { threadId: thread, turn: { id: turn, status: "inProgress" } } });
    if (!params.input[0].text.includes("WAIT_FOR_CANCELLATION")) {
      send({ method: "thread/tokenUsage/updated", params: { threadId: thread, turnId: turn, tokenUsage: { total: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } } } });
      send({ method: "item/completed", params: { threadId: thread, item: { id: "message", type: "agentMessage", text: "Fixture completed without editing anything." } } });
      // Completion intentionally precedes the request response: real protocols can race.
      send({ method: "turn/completed", params: { threadId: thread, turn: { id: turn, status: "completed" } } });
    }
    send({ id, result: { turn: { id: turn, status: "inProgress" } } });
  } else if (method === "turn/interrupt") {
    send({ id, result: {} });
    send({ method: "turn/completed", params: { threadId: thread, turn: { id: turn, status: "interrupted" } } });
  } else if (method === "fixture/malformed") process.stdout.write("not JSON\n");
  else if (method === "fixture/ping") send({ id, result: { ok: true } });
  else send({ id, error: { code: -32601, message: "Unknown fixture method" } });
}
