const $ = (selector) => document.querySelector(selector);
const state = { token: sessionStorage.getItem("ploop-admin") ?? "", tasks: [], projects: [], selected: null, cursor: null, detailVersion: "", listVersion: "", busy: false };
const labels = { new: "待确认", queued: "排队中", running: "执行中", verified: "补丁已验证", failed: "需要关注", cancelled: "已取消", recovery_required: "需要核对" };
const phases = { preparing: "准备工作区", baseline: "复现与基准验收", running: "编码 Agent 执行", freezing: "固定候选 commit", verifying: "独立验收", verified: "补丁验证通过", queued: "等待 Bridge", awaiting_approval: "等待你确认", failed: "执行未完成", cancelled: "已停止", recovery_required: "核对执行状态" };
const node = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
const short = (id) => id?.slice(0, 8) ?? "—";
const time = (value) => new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const projectName = (id) => state.projects.find((p) => p.id === id)?.name ?? "项目";
const badge = (task) => node("span", `badge ${task.state}`, task.cancelRequested && ["running", "recovery_required"].includes(task.state) ? "等待停止确认" : labels[task.state] ?? task.state);

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, { method, headers: { authorization: `Bearer ${state.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) lock(); throw new Error(result.error?.message ?? "请求失败"); }
  return result;
}
function lock() { document.body.dataset.auth = "locked"; state.token = ""; sessionStorage.removeItem("ploop-admin"); }
function notice(message) { $("#global-error").textContent = message; $("#global-error").hidden = !message; }
function setView(view) {
  for (const name of ["inbox", "projects", "bridges"]) $(`#${name}-view`).hidden = name !== view;
  document.querySelectorAll("[data-view]").forEach((button) => { button.classList.toggle("active", button.dataset.view === view); });
}
function renderTasks() {
  const version = JSON.stringify(state.tasks) + state.selected;
  if (version === state.listVersion) return; state.listVersion = version;
  const list = $("#task-list"), focused = document.activeElement?.dataset?.task;
  list.replaceChildren();
  if (!state.tasks.length) list.append(node("p", "empty-list", "还没有反馈。打开订单示例，体验第一条反馈的完整流程。"));
  for (const task of state.tasks) {
    const row = node("button", `task-row ${task.id === state.selected ? "selected" : ""}`); row.type = "button"; row.dataset.task = task.id;
    row.setAttribute("aria-current", String(task.id === state.selected));
    const meta = node("div", "row-meta"); meta.append(node("span", "mono", `#${short(task.id)}`), node("span", "", time(task.createdAt)));
    const bottom = node("div", "row-bottom"); bottom.append(badge(task), node("span", "", projectName(task.projectId)));
    row.append(meta, node("h3", "", task.title), bottom);
    row.addEventListener("click", () => { state.selected = task.id; state.detailVersion = ""; renderTasks(); void refreshDetail(); }); list.append(row);
  }
  if (focused) list.querySelector(`[data-task="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  $("#load-more").hidden = !state.cursor;
}
const eventLabel = (event) => {
  if (event.type === "execution.phase") return phases[event.data.phase] ?? event.data.phase;
  return ({ "feedback.received": "收到反馈", "task.approved": "已确认执行范围", "task.claimed": "Bridge 已领取", "agent.started": "编码 Agent 已启动", "verification.baseline": "基准验收完成", "verification.passed": "独立验收通过", "task.finished": `执行结束 · ${labels[event.data.status] ?? event.data.status}`, "task.cancel_requested": "已请求停止", "task.lease_expired": "执行端心跳中断", "task.recovery_required": "执行状态需要核对", "agent.closed": "Agent 进程已关闭", "execution.failed": "执行失败", "execution.cancelled": "执行已取消" })[event.type];
};
async function mutate(id, operation) {
  state.busy = true;
  try { const task = await api(`/api/tasks/${id}/${operation}`, { method: "POST" }); state.detailVersion = ""; renderDetail(task); await refresh(); }
  catch (error) { notice(error.message); }
  finally { state.busy = false; state.detailVersion = ""; void refreshDetail(); }
}
function renderDetail(task) {
  const version = `${task.id}:${task.updatedAt}:${task.events?.at(-1)?.sequence}:${task.cancelRequested}:${state.busy}`;
  if (state.detailVersion === version) return; state.detailVersion = version;
  const panel = $("#task-detail"); panel.replaceChildren();
  const top = node("div", "detail-top"); top.append(node("span", "mono", `${projectName(task.projectId)} / #${short(task.id)}`), badge(task));
  panel.append(top, node("h2", "", task.feedback.title), node("div", "feedback-quote", task.feedback.description));
  const expected = node("p", "expected"); expected.append(node("strong", "", "期待的结果："), document.createTextNode(task.feedback.expected)); panel.append(expected);
  const actions = node("div", "action-bar");
  if (task.state === "new") { const b = node("button", "button primary", "确认并交给 Codex →"); b.disabled = state.busy; b.addEventListener("click", () => void mutate(task.id, "approve")); actions.append(b); }
  if (["new", "queued", "running"].includes(task.state) && !task.cancelRequested) { const b = node("button", "button danger", task.state === "new" ? "取消处理" : "请求停止"); b.disabled = state.busy; b.addEventListener("click", () => void mutate(task.id, "cancel")); actions.append(b); }
  panel.append(actions);
  if (task.cancelRequested && task.state === "running") panel.append(node("div", "notice", "已请求停止，正在等待执行端确认；当前尚未确认为停止。"));
  if (task.state === "recovery_required") panel.append(node("div", "notice danger-notice", "此前执行的终态未确认。工作区与记录已保留，需要检查 Bridge 状态；系统不会自动重新执行。"));
  if (task.result?.error) panel.append(node("div", "notice danger-notice", `${task.result.error.code}: ${task.result.error.message ?? "请检查执行记录"}`));
  const result = task.result;
  if (result) {
    const section = node("div", "detail-section"); section.append(node("div", "section-label", "VERIFICATION & EVIDENCE"));
    if (result.verification) {
      const facts = node("div", "facts"), summary = result.verification.summary;
      const tests = node("div", "fact"); tests.append(node("span", "", "独立验收"), node("strong", "", `${summary.pass}/${summary.tests}`), node("small", "", "通过"));
      const duration = node("div", "fact"); duration.append(node("span", "", "执行耗时"), node("strong", "", result.metrics?.elapsedMs !== null && result.metrics?.elapsedMs !== undefined ? (result.metrics.elapsedMs / 1000).toFixed(1) : "—"), node("small", "", "秒")); facts.append(tests, duration); section.append(facts);
    }
    const commits = node("div", "commit-facts"); commits.append(node("span", "", "BASE"), node("code", "", result.baseCommit ?? "—"), node("span", "", "CANDIDATE"), node("code", "", result.candidateCommit ?? "未生成")); section.append(commits);
    if (result.patch) {
      const b = node("button", "button secondary", "下载已验证补丁 ↓");
      b.addEventListener("click", async () => {
        try {
          const response = await fetch(`/api/tasks/${task.id}/patch`, { headers: { authorization: `Bearer ${state.token}` } }); if (!response.ok) throw new Error("补丁不可用");
          const url = URL.createObjectURL(await response.blob()), link = node("a"); link.href = url; link.download = `ploop-${short(task.id)}.patch`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) { notice(error.message); }
      });
      const bar = node("div", "action-bar"); bar.append(b); section.append(bar);
      const details = node("details"); details.append(node("summary", "", "查看补丁"), node("pre", "", result.patch)); section.append(details);
    }
    if (task.state === "verified") section.append(node("p", "field-help", "补丁已通过验收，尚未应用、合并或确认上线。"));
    if (result.artifactNotice) section.append(node("p", "field-help", result.artifactNotice));
    if (result.verification?.stdout?.text) { const details = node("details"); details.append(node("summary", "", "查看验收输出"), node("pre", "", result.verification.stdout.text)); if (result.verification.stdout.omittedBytes) details.append(node("p", "field-help", `此前 ${result.verification.stdout.omittedBytes} 字节保留在 Bridge 完整报告中。`)); section.append(details); }
    if (result.reportDirectory) section.append(node("p", "field-help", `完整运行记录保留于 ${result.reportDirectory}`));
    panel.append(section);
  }
  const timeline = node("div", "detail-section"); timeline.append(node("div", "section-label", "ACTIVITY"));
  const list = node("ol", "timeline");
  for (const event of task.events ?? []) { const label = eventLabel(event); if (!label) continue; const li = node("li"); li.append(node("span", "", label), node("time", "", time(event.createdAt))); list.append(li); }
  if (task.eventCoverage?.total > (task.events?.length ?? 0)) timeline.append(node("p", "field-help", `当前显示最近 ${task.events.length} / ${task.eventCoverage.total} 条事件中的阶段摘要；完整记录保留在 Hub 与 Bridge。`));
  timeline.append(list); panel.append(timeline);
}
async function refreshDetail() {
  if (!state.selected || !state.token) return;
  const id = state.selected;
  try { const task = await api(`/api/tasks/${id}`); if (state.selected === id) renderDetail(task); }
  catch (error) { notice(error.message); }
}
function renderProjects() {
  const list = $("#project-list"); list.replaceChildren();
  for (const p of state.projects) {
    const card = node("article", "project-card"); card.append(node("p", "eyebrow", `PROJECT / ${short(p.id)}`), node("h2", "", p.name), node("div", "path", p.config.repository));
    const dl = node("dl");
    for (const [name, value] of [["允许修改", p.config.allowedPaths.join(" · ")], ["验收命令", JSON.stringify(p.config.acceptance.command)], ["预期验收项", String(p.config.acceptance.expectedTests)], ["采集 Key（只允许提交）", p.publicKey]]) dl.append(node("dt", "", name), node("dd", "mono", value));
    card.append(dl); list.append(card);
  }
}
function renderBridges(devices) {
  const list = $("#bridge-list"); list.replaceChildren();
  for (const device of devices) {
    const online = device.lastSeen && Date.now() - device.lastSeen < 7000;
    const card = node("article", "project-card"); card.append(node("p", "eyebrow", "EXECUTION DEVICE"), node("h2", "", device.name), node("span", `badge ${online ? "verified" : "cancelled"}`, online ? "心跳在线" : "未连接"), node("p", "path", device.id));
    card.append(node("p", "field-help", device.lastSeen ? `最近心跳 ${time(device.lastSeen)}` : "等待本地 Bridge 连接")); list.append(card);
  }
}
async function refresh({ reset = false } = {}) {
  if (!state.token) return;
  try {
    const [status, projects, page] = await Promise.all([api("/api/status"), api("/api/projects"), api("/api/tasks?limit=50")]);
    document.body.dataset.auth = "connected"; notice("");
    state.projects = projects.items;
    const older = reset ? [] : state.tasks.filter((task) => !page.items.some((next) => next.id === task.id));
    state.tasks = [...page.items, ...older]; if (reset || !older.length) state.cursor = page.nextCursor;
    const counts = Object.fromEntries(status.counts.map((c) => [c.state, c.count]));
    $("#stat-new").textContent = counts.new ?? 0; $("#stat-active").textContent = (counts.running ?? 0) + (counts.queued ?? 0); $("#stat-verified").textContent = counts.verified ?? 0; $("#stat-attention").textContent = (counts.failed ?? 0) + (counts.recovery_required ?? 0); $("#nav-count").textContent = Object.values(counts).reduce((a, b) => a + b, 0);
    const online = status.devices.some((d) => d.lastSeen && Date.now() - d.lastSeen < 7000);
    $("#bridge-indicator").textContent = online ? "Bridge 心跳在线" : "Bridge 未连接"; $("#bridge-indicator").classList.toggle("online", online);
    if (!state.selected && state.tasks.length) state.selected = state.tasks[0].id;
    renderTasks(); renderProjects(); renderBridges(status.devices); await refreshDetail();
  } catch (error) { notice(error.message); throw error; }
}
$("#connect-form").addEventListener("submit", async (event) => {
  event.preventDefault(); state.token = $("#admin-key").value.trim();
  try { await refresh({ reset: true }); sessionStorage.setItem("ploop-admin", state.token); $("#admin-key").value = ""; $("#connect-error").textContent = ""; }
  catch (error) { $("#connect-error").textContent = error.message; }
});
$("#disconnect").addEventListener("click", lock);
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
$("#load-more").addEventListener("click", async () => {
  try { const page = await api(`/api/tasks?limit=50&cursor=${encodeURIComponent(state.cursor)}`); const seen = new Set(state.tasks.map((t) => t.id)); state.tasks.push(...page.items.filter((t) => !seen.has(t.id))); state.cursor = page.nextCursor; renderTasks(); }
  catch (error) { notice(error.message); }
});
$("#add-project").addEventListener("click", () => $("#project-dialog").showModal()); $("#close-project").addEventListener("click", () => $("#project-dialog").close());
$("#project-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = new FormData(event.target), lines = (key) => String(form.get(key)).split("\n").map((s) => s.trim()).filter(Boolean);
  try { await api("/api/projects", { method: "POST", body: { name: form.get("name"), repository: form.get("repository"), allowedPaths: lines("paths"), origins: lines("origins"), acceptance: { command: JSON.parse(form.get("command")), sourceFiles: lines("sources"), expectedTests: Number(form.get("tests")), baselineMustFail: form.has("baselineFail") } } }); $("#project-dialog").close(); event.target.reset(); await refresh(); }
  catch (error) { $("#project-error").textContent = error.message; }
});
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has("key")) { state.token = fragment.get("key"); history.replaceState(null, "", location.pathname); sessionStorage.setItem("ploop-admin", state.token); }
if (state.token) void refresh({ reset: true }).catch(() => {});
setInterval(() => { if (state.token && !document.hidden) void refresh().catch(() => {}); }, 2000);
