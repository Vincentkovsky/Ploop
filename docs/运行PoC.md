# 运行 Ploop M0 PoC

需要浏览器工作台、SDK 与持久任务系统时，使用[本地 MVP](本地MVP.md)。本 CLI 与 Bridge 共用执行和独立验收内核，仍是独立的单次实验入口。

这个 CLI 验证合成反馈经本地 Codex 变成可独立验收的代码补丁。它不启动公网服务，也不自动向 GitHub 发布。Node.js 22+、Git、tar 和已登录的 Codex 需由使用者准备；当前没有第三方 npm 依赖。

```bash
npm test
npm run doctor
npm run poc
```

`doctor` 只检查本地 CLI、账号状态和模型目录；账号已登录或模型出现在目录中，都不等于一次实际推理已经成功。

`poc` 会消耗模型用量。默认沿用本地 Codex 的模型配置；可以显式选择可执行路径、模型、任务预算和数据目录：

```bash
node src/cli.mjs run --codex /absolute/path/to/codex --timeout 180000
node src/cli.mjs run --model MODEL_ID --data-dir /absolute/path/to/run-data
node src/cli.mjs report /absolute/path/to/run-data/RUN_ID
```

反馈输入可由 `--feedback FILE` 指定，格式参见 `examples/orders/feedback.json`。它始终针对内置的订单示例，不允许反馈指定任意仓库、路径或执行命令。`--timeout` 以毫秒计，取消另有有限的确认和清理等待时间。当前 PoC 为内存中的 JSON 输入设置 64 KiB 预算，候选源文件和命令输出各有 1 MiB 预算，RPC 帧有 8 MiB 预算；这是实验执行器的资源约束，不是这些格式的固有限制。

## 一次执行会做什么

1. 保留反馈原始字节和摘要，创建独立运行目录。
2. 复制有意保留 Bug 的订单示例，初始化由 Ploop 拥有的 Git 仓库和 worktree。
3. 在 base commit 的独立快照上运行 8 项维护者验收，确认 Bug 确实复现。
4. 通过 Codex app-server stdio 发起真实任务，仅允许修改 `src/export-orders.mjs`；使用 workspace-write、关闭任务命令的网络访问，不接受权限升级请求。
5. 等待真实 turn 终态和 app-server 关闭，检查改动范围，再由编排器创建候选 commit。
6. 对候选 commit 的全新快照运行同一组外部验收，确认源码和验收文件未在测试中变化。
7. 只有 Agent 正常完成且独立验收全部通过，才写入 `verified`，并保留补丁与来源摘要。

## 运行数据

默认目录为 `.ploop/runs/RUN_ID/`，已被 Git 忽略：

| 文件或目录 | 内容 |
|---|---|
| `feedback-source.json` | 反馈输入的原始字节 |
| `report.json` | 状态、commit、命令、验收输出、Agent 公共回复、usage 及限制 |
| `events.jsonl` | 有序的阶段事件和 Agent 公开事件的必要投影，不是完整原始协议流 |
| `repository/` 与 `worktree/` | 示例的 Git 仓库和 Agent 工作区 |
| `baseline/` 与 `verified/` | 对应 commit 的验收快照 |
| `fix.patch` | 已通过验收的修复补丁，仅成功执行生成 |

运行目录默认保留，便于检查失败和局部结果。没有自动重试、重启恢复或自动删除机制。目录可能包含开发者提交的反馈，因此不应直接整体加入 GitHub；公开验证记录只导出必要事实，完整记录保留在本地。

## 当前验证范围

控制测试验证了提前到达的 turn 终态、协议异常、协议取消、验收期间源码变化、修改范围限制，以及 Agent 空口报告成功不能造成假通过。这些测试的 Agent 是明确标注的模拟进程。

真实验证使用一次本地 Codex 和一个合成 Bug。新增真实账号取消与超时，以及浏览器任务经 Hub 重启后取消的验证，详见[本地 MVP 实测](verification/mvp-2026-11-03.md)。会话恢复、长时间断网、升级和完整跨平台行为仍未建立覆盖。

workspace-write 是写入范围配置，不代表与开发者主机的凭证、读取权限和所有子进程已经全面隔离。PoC 仅针对这里的受控示例，不适合直接运行不受信任的仓库。原生 CLI 可继承本机配置与环境，但 Ploop 不把环境或登录文件写入运行记录。

没有独立测量 CPU、进程族峰值内存或实际订阅费用。usage 是 app-server 上报值，缓存输入属于输入的子集，推理输出属于输出的子集，不能再重复相加。
