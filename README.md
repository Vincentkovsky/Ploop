# Ploop

Turn feedback into pull requests.

Ploop 是面向开发者的开源反馈修复工具：把 Web 应用里的用户反馈交给本地编码 Agent，留下独立验收、候选 commit 和可审查的修复补丁。

当前提供**可以从源码启动的本地 MVP**：Web SDK → SQLite Hub → 人工确认 → 本地 Bridge / Codex → 独立验收 → 补丁下载。2026-11-03 已在浏览器提交合成反馈并完成真实 Codex 修复，8 项验收从 5 项失败变为全部通过；取消、超时及 Hub 重启有分层验证记录。GitHub 自动创建 PR、上线跟踪和公网部署仍在后续范围内。

## 本地启动

准备 Node.js 22.11.0+、Git、tar，以及已通过官方方式登录的 Codex CLI。本机实测 macOS arm64、Node 22.11.0、Codex CLI 0.166.0-alpha.5.1。没有第三方 npm 依赖，也没有已发布安装包。

```bash
git clone https://github.com/Vincentkovsky/Ploop.git
cd Ploop
git switch codex/poc-feedback-to-fix
npm ci --ignore-scripts
npm run doctor
npm start
```

当前实现位于 [draft PR #1](https://github.com/Vincentkovsky/Ploop/pull/1) 对应分支。打开 [本地工作台](http://127.0.0.1:4317)，从终端提示的 `.ploop/hub/secrets.json` 读取本机管理 key 并登录；[反馈示例](http://127.0.0.1:4317/demo) 可以复现订单只导出前 100 条的问题。

在示例提交反馈后，到工作台确认并交给 Codex。批准会发起真实模型调用，消耗所选账户或 API 额度。完整记录默认保留在 `.ploop/`，不会自动合并、推送或部署代码。示例修复通过后，原示例页面仍保留 Bug，等待开发者应用补丁和发布。

详细的仓库绑定、验收配置、SDK 接入、分开运行 Hub / Bridge 和恢复步骤见[本地 MVP 指南](docs/本地MVP.md)。仅想运行单次 CLI 实验可看[PoC 说明](docs/运行PoC.md)。

## 已实现的范围

- 收件箱、反馈详情、活动记录、项目设置和 Bridge 心跳；明确区分请求停止与确认停止。
- 无框架 Web SDK，保留反馈原文，重复提交使用同一标识；只读回执只能查看本工单有限状态。
- 显式绑定本地 Git 仓库、允许改动的文件和维护者验收；批准时固定 base SHA 与配置摘要。
- 每个 Bridge 串行执行，在独立 worktree 中调用 Codex；对冻结候选 commit 的新快照执行外部 Node TAP 验收。
- SQLite 事务保存领取状态，Bridge outbox 持久补报；回执丢失不会重跑 Agent。未知执行保留为“需要核对”。
- 独立验收结果、base / candidate SHA、日志摘要和已验证补丁可在页面核对；完整报告保留在 Bridge 本机。

这是**单机、单实例、可信仓库**的开发预览。Hub 只监听 `127.0.0.1`，Bridge 只接受该地址；不提供远程配对、附件上传、用户权限体系、自动恢复未知进程、GitHub publisher 或正式安装分发。Codex 的 workspace-write 配置不构成完整的主机读取和凭证隔离。当前不要把它作为公网服务或运行不受信任的仓库。

## 验证与后续工作

```bash
npm run check
npm test
```

自动检查使用明确标注的可控 Agent；CI 在 Linux / macOS 与 Node 22.11 / 24 上运行。真实模型验证独立记录，运行 `npm run verify:real` 会额外消耗用量。

- [本地 MVP 与原生生命周期实测](docs/verification/mvp-2026-11-03.md)：浏览器反馈、真实修复、重启后取消、原生取消和超时、测量与限制。
- [首次 M0 实测](docs/verification/poc-2026-11-03.md)：历史 CLI 实验。
- [产品与技术方案](docs/方案.md)、[实施与验收路线](docs/实施路线.md)：目标与尚待验证的范围。
- [公开证据与复用边界](docs/research/公开证据.md)、[来源清单](docs/research/sources.json)：固定版本的研究材料。

下一阶段先补 GitHub draft PR 的受控发布与核对，再扩展公网 Hub 和正式安装包；每项能力通过实际验证后再列入支持范围。

## 名称与许可

品牌名使用 Ploop。npm 的非 scoped 包 `ploop` 已存在；未来发布需要维护者拥有的 scope，本仓库当前为 private package 配置以防误发布。

Ploop 自有实现使用 [MIT 许可证](LICENSE)。没有复制 Gleap 的 runner、提示词或界面资产，也没有打包 Codex。第三方软件仍适用各自许可证。
