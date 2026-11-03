import { createFeedbackClient } from "/sdk.mjs";
const $ = (s) => document.querySelector(s), orders = Array.from({ length: 250 }, (_, i) => ({ id: `ORD-${String(i + 1).padStart(4, "0")}`, customer: `示例客户 ${i + 1}` }));
for (const order of orders.slice(0, 10)) { const row = document.createElement("tr"); for (const value of [order.id, order.customer]) { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); } $("#orders").append(row); }
let client, receipt, pending;
try { receipt = JSON.parse(sessionStorage.getItem("ploop-demo-receipt")); pending = JSON.parse(sessionStorage.getItem("ploop-demo-pending")); } catch { /* No valid retained submission. */ }
const statusLabels = { new: "反馈已收到，等待开发者确认。", queued: "已批准，等待执行。", running: "正在处理你的反馈。", verified: "补丁已经通过验收，等待开发者发布。", failed: "这次执行需要开发者进一步检查。", cancelled: "这次处理已取消。", recovery_required: "执行状态需要开发者核对；你的反馈已保留。" };
async function status() {
  if (!receipt || !client) return;
  try { const result = await client.status(receipt); $("#receipt").hidden = false; $("#receipt").textContent = `${statusLabels[result.state] ?? result.state} #${receipt.id.slice(0, 8)}`; }
  catch (error) { $("#feedback-error").textContent = error.message; }
}
try {
  const configResponse = await fetch("/api/demo"); const config = await configResponse.json(); if (!configResponse.ok) throw new Error(config.error?.message ?? "示例未启用");
  client = createFeedbackClient({ endpoint: location.origin, projectKey: config.projectKey });
  const { exportOrders } = await import("/demo/export-orders.mjs");
  $("#export").addEventListener("click", async () => {
    try {
      const csv = await exportOrders(async ({ cursor, limit }) => { const start = cursor === null ? 0 : Number(cursor); return { orders: orders.slice(start, start + limit), nextCursor: start + limit < orders.length ? String(start + limit) : null }; });
      const count = csv.split("\n").length - 1; $("#export-result").hidden = false; $("#export-result").textContent = `导出了 ${count} 条 / 共 250 条。${count < 250 ? "问题已复现，可以提交反馈。" : "当前导出完整。"}`;
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })), link = document.createElement("a"); link.href = url; link.download = "orders-demo.csv"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { $("#feedback-error").textContent = error.message; }
  });
  $("#feedback-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const button = event.target.querySelector("button"); button.disabled = true;
    try {
      const form = new FormData(event.target), feedback = { schemaVersion: 1, kind: "bug", title: form.get("title"), description: form.get("description"), expected: form.get("expected"), context: { appVersion: config.appVersion, pagePath: location.pathname, observations: ["Browser order-desk demo; all records are synthetic"] } };
      if (!pending || pending.body !== JSON.stringify(feedback)) pending = client.prepare(feedback);
      sessionStorage.setItem("ploop-demo-pending", JSON.stringify(pending)); receipt = await client.send(pending); pending = null;
      sessionStorage.removeItem("ploop-demo-pending"); sessionStorage.setItem("ploop-demo-receipt", JSON.stringify(receipt)); $("#feedback-error").textContent = ""; await status();
    } catch (error) { $("#feedback-error").textContent = `${error.message}；重试会沿用这次提交的标识。`; }
    finally { button.disabled = false; }
  });
  await status(); setInterval(() => { if (!document.hidden) void status(); }, 3000);
} catch (error) { $("#feedback-error").textContent = error.message; $("#export").disabled = true; }
