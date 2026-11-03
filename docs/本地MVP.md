# 本地 MVP 使用指南

日期：2026-11-03。这是单机开发预览，当前只支持 HTTP `127.0.0.1` Hub 与同机 Bridge。需要 Node.js 22.11.0+、Git、tar 和已登录的 Codex；Node 内置 SQLite 在实测版本需要 `--experimental-sqlite`，npm 启动脚本已带此选项。

## 跑通示例

在仓库目录执行：

```bash
npm ci --ignore-scripts
npm run doctor
npm start
```

1. 打开 `http://127.0.0.1:4317`，将 `.ploop/hub/secrets.json` 中的 `adminToken` 输入本地工作台。文件和数据库默认仅当前用户可读。
2. 打开 `/demo`，导出订单，核对“100 条 / 共 250 条”，再提交表单。数据均为合成数据。
3. 回工作台查看反馈，点击“确认并交给 Codex”。批准前不会运行 Agent；批准时固定仓库 commit 与验收配置。
4. 查看复现、编码和独立验收阶段。成功后核对 8/8、候选 SHA 和补丁，下载后人工审查。
5. 页面上的“补丁已验证”表示该 commit 通过本项目验收。应用、合并、上线仍需开发者处理，示例页面不会自动替换源码。

`doctor` 只检查 CLI、账号状态和模型目录，不发起推理。批准任务和 `npm run poc` / `npm run verify:real` 会消耗模型用量。默认沿用本地 Codex 配置；不读取或改写用户登录文件。

可以显式选择 Agent、模型、端口和目录：

```bash
npm start -- --codex /absolute/path/to/codex --model MODEL_ID --timeout 180000
npm start -- --port 4318 --data-dir /absolute/path/to/ploop-data
npm start -- --empty
```

`--empty` 在首次启动时不创建内置项目；已有数据会保留。超时参数单位为毫秒，CLI 接受 1000–2147483647；取消确认和进程关闭另有有限等待时间。

## 分开运行 Hub 与 Bridge

两个终端各运行一个服务：

```bash
npm run hub
npm run bridge
```

默认 Hub 目录 `.ploop/hub`，Bridge 目录 `.ploop/bridge`。自定义目录时分别指定，并把 Hub 生成的连接文件交给 Bridge：

```bash
npm run hub -- --data-dir /absolute/path/to/hub --port 4318
npm run bridge -- --hub http://127.0.0.1:4318 --connection /absolute/path/to/hub/bridge.json --data-dir /absolute/path/to/bridge
```

`npm start -- --data-dir BASE` 使用 `BASE/hub` 与 `BASE/bridge`；单独的 `hub` / `bridge` 命令把 `--data-dir` 直接作为各自目录。每个数据库只允许一个进程打开，连接文件与 Bridge journal 绑定同一个 Hub、设备及凭证；不要把已有 journal 指向另一套 Hub。

Ctrl+C 请求停止。合并启动模式先等待 Bridge 停止并补报，再关闭 Hub。两进程模式应先停 Bridge；Hub 暂时不可用时 outbox 保留，等待有限时间后退出，不删除现场。

## 绑定自己的可信仓库

在“项目”页面填写绝对 Git 仓库根目录、允许修改的**现有文件**、验收 argv JSON、验收源文件绝对路径、预期测试数及允许的浏览器 Origin。

例如维护者在仓库外准备 `export.test.mjs`，通过 `process.env.PLOOP_TARGET` 找到待验收快照：

```json
{
  "name": "My local app",
  "repository": "/absolute/path/to/app",
  "allowedPaths": ["src/export-orders.mjs"],
  "acceptance": {
    "command": ["/absolute/path/to/node", "--test", "--test-reporter=tap", "/absolute/path/to/acceptance/export.test.mjs"],
    "sourceFiles": ["/absolute/path/to/acceptance/export.test.mjs"],
    "expectedTests": 8,
    "baselineMustFail": true
  },
  "origins": ["http://127.0.0.1:5173"]
}
```

验收命令由维护者配置，以 argv 直接执行；反馈不能提供命令或文件范围。MVP 只识别 Node TAP 汇总，必须完成声明的测试数，不能跳过或取消。`baselineMustFail` 勾选时要求基准明确失败；取消勾选允许对原本通过的基准继续执行。

项目绑定时固定 Git common directory 身份、绑定 commit 和外部验收源文件摘要；批准时重新核对，要求 tracked 文件干净，并固定当时 HEAD。Agent 只能提交声明文件中的修改，验证使用候选 commit 的独立快照，并在验收前后核对源树及验收文件摘要。测试执行时 `PLOOP_TARGET` 指向快照目录；外部文件及相关依赖的完整声明由项目维护者负责。

当前快照只接受常规文件，不支持 symlink、submodule，或无法无损表示的路径；目录包含不支持的条目时明确拒绝。执行预算为最多 5000 个文件、单文件 8 MiB、源树合计 32 MiB；候选允许改动的文件各不超过 1 MiB。没有自动安装依赖，也不会把原目录的 `node_modules` 复制进验收快照。这些是 MVP 的资源和实现范围，不是 Git 的格式限制。

## Web SDK 接入

SDK 文件由 Hub 的 `/sdk.mjs` 提供，也可以把本仓库 `public/sdk.mjs` 作为源码模块引入本地应用。项目页面显示的采集 key 是公开标识，只能提交反馈；它不能读取工单详情或批准执行。

```javascript
import { createFeedbackClient } from "http://127.0.0.1:4317/sdk.mjs";

const feedback = createFeedbackClient({
  endpoint: "http://127.0.0.1:4317",
  projectKey: "PROJECT_INGESTION_KEY"
});
const prepared = feedback.prepare({
  schemaVersion: 1,
  kind: "bug",
  title: "导出不完整",
  description: "250 条订单只导出了 100 条。",
  expected: "导出全部订单，保持字段和顺序。",
  context: { appVersion: "local-dev", pagePath: "/orders", observations: [] }
});
const receipt = await feedback.send(prepared);
console.log(await feedback.status(receipt));
```

在实际应用中保留 `prepared`，网络失败后重试同一个对象，避免重复工单。`receipt` 带随机客户端回执 key，需保留才能查询该反馈状态；不要把它放进 URL 或日志。只读回执不包含反馈、执行日志、路径或补丁。

SDK 仅提交显式传入的文本和上下文，不自动采集页面、控制台、网络流量或浏览历史。请求限 64 KiB UTF-8 JSON，不支持附件。跨域应用必须在项目里声明精确 Origin；MVP 仍只适合同机本地开发页面，不是线上产品 SDK 部署方案。

## 重试、取消与恢复

- 重复领取对应同一 attempt。Bridge 先写持久领取记录再启动执行；进度和结果进入 outbox，Hub 回执后才删除待发项。
- Hub 短时重启后原 Bridge 可继续心跳并上报。租约过期则进入 `recovery_required`，不会自动分配第二次执行；原 attempt 仍可报告经确认的实际结果。
- 执行中点击停止只设置意图，页面显示“等待停止确认”。Bridge 请求原生 `turn/interrupt`，等待终态及进程关闭；如果修复已先完成，会记录实际结果及较晚的停止请求。
- Bridge 重启后，有匹配的终态报告与 owner 记录则补报结果；没有确证时保留 active 记录并进入“需要核对”，退出码 2，不重跑也不按旧 PID 杀进程。
- 目前没有“强制清空 / 重试未知任务”按钮。检查原 Bridge 是否仍在运行、保留的 `report.json`、`events.jsonl` 和 worktree；确认问题前不要删除 journal 或复用同一反馈启动第二次执行。匹配终态报告补齐后可再次启动原 Bridge 进行核对与补报。其他未知情况需要人工处理，自动恢复向导尚未实现。

## 数据与备份

| 路径 | 内容 |
|---|---|
| `.ploop/hub/hub.sqlite` | 项目、反馈原文、领取、事件、紧凑结果 |
| `.ploop/hub/secrets.json` | 本机管理 key |
| `.ploop/hub/bridge.json` | 本地设备身份与认证凭证 |
| `.ploop/hub/demo-repository` | Ploop 拥有的示例仓库 |
| `.ploop/bridge/bridge.sqlite` | 领取意图、执行所有权与 outbox |
| `.ploop/bridge/runs/ATTEMPT_ID` | 反馈原文、owner、完整报告、事件、worktree、验收快照和补丁 |

先正常停止 Bridge 与 Hub，再整体复制两者目录及绑定仓库，保留原路径和权限。运行中的数据库文件单独复制不作为一致性备份。当前只有 schema v1，没有跨版本升级或备份恢复认证；不要直接覆盖现有数据来测试升级。

工作台详情返回最近 200 条事件并声明总数；Hub 数据库仍保留全部事件。日志和 Agent 公共回复在 Hub 中只保留有省略标记的摘要，完整内容保留在 Bridge 报告。补丁 JSON 表示超过 2 MiB 时仅保留本地文件并提示原因。没有自动删除、空间回收或总量配额，使用者应关注磁盘空间；磁盘满和硬断电恢复尚未形成完整验证覆盖。

## 验证边界

自动检查覆盖身份、去重、回执权限、回传丢失、Hub 重启、未知 Bridge 恢复、取消、进程组、范围限制和独立验收。真实模型与浏览器记录见[实测证据](verification/mvp-2026-11-03.md)，可控执行器的通过不代表所有 Agent 行为已验证。

只在可信本机仓库中使用。workspace-write 和禁用任务网络不是完整容器隔离，也不保证 Agent 无法读取主机数据或访问所有继承凭证。当前发布动作由开发者手动完成。Windows、公网 HTTPS、多设备配对、GitHub webhook / publisher、附件、安装升级与生产隔离均未列为支持能力。
