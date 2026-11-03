const key = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

export function createFeedbackClient({ endpoint, projectKey }) {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("endpoint must be an HTTP origin");
  const origin = url.origin;
  async function call(path, options) {
    const response = await fetch(`${origin}${path}`, { credentials: "omit", ...options });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error?.message ?? "Feedback request failed"), { code: result.error?.code, status: response.status });
    return result;
  }
  return {
    prepare(feedback) { return { requestId: crypto.randomUUID(), receiptKey: key(), body: JSON.stringify(feedback) }; },
    async send(submission) {
      const result = await call("/api/feedback", { method: "POST", headers: { authorization: `Ingest ${projectKey}`, "content-type": "application/json", "idempotency-key": submission.requestId, "x-ploop-receipt-key": submission.receiptKey }, body: submission.body });
      return { id: result.id, receiptKey: submission.receiptKey, duplicate: result.duplicate };
    },
    status(receipt) { return call(`/api/receipts/${encodeURIComponent(receipt.id)}`, { headers: { authorization: `Receipt ${receipt.receiptKey}` } }); }
  };
}
