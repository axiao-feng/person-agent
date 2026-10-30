# 更新日志

## v0.2.0 — 2026-10-30

首个可日常使用的 Windows 原生客户端版本。

### 新增

**本地应用服务**
- `person-agent serve --port 0`：仅监听 `127.0.0.1`，一次性会话 token、Host/Origin 校验、请求体限制、稳定错误码、`requestId` / `generatedAt`。
- OpenAPI 合同全部接口：健康、今日、任务、候选时段、排期、日历、讲座、Idea、论文、知识同步/整理、operation、审批、设置、搜索和 Agent。
- 今日聚合：真实今日重点、时间线、知识流、待审批；Calendar 或天气失败时返回 `partial`，本地数据继续可用。
- 任务状态机：开始、完成、取消只接受合法迁移；`planned` 只能由已批准的 Calendar 操作产生。
- `operations` 表：知识同步/整理持久化状态、同类复用、跨类型互斥、真实阶段上报（同步 → 分析 → 写入日报）。
- Calendar 审批执行：只执行已持久化的固定 payload；`calendar.create` 使用稳定事件 ID，重试不重复创建。
- 设置：`briefingEnabled` / `knowledgeDigestEnabled` 持久化；保存后同步更新 `jobs`，worker 每 30 秒重载配置。
- 搜索：聚合任务、论文、讲座和 Obsidian Idea；Agent 回答与库内结果分区。

**WPF 客户端（.NET 8，`client/PersonAgent.Desktop`）**
- 三栏窗口：五个一级入口、中央工作区、右侧对象/审批/任务详情面板、底部服务状态。
- 今日：重点、时间线、知识流、审批卡；批准/拒绝 Calendar 操作。
- 知识库：论文筛选、分析详情、Zotero/Obsidian 打开、手动同步与整理。
- 任务：待安排/已计划/最近完成/已取消分组、编辑、开始、完成、取消、候选空闲时段、生成审批。
- 日历：一周七列视图，聚合 Google 日程、本地讲座、已计划任务和待审批时段。
- 设置：七类连接状态、自动化开关与时间、知识库路径、时区、诊断入口。
- 快速记录：Idea / 任务 / 讲座三种独立表单。
- `Ctrl+K`：搜索、问 Agent、快速记录；搜索结果可跳转任务或论文详情。
- 真实状态：loading / refreshing / success / empty / partial / error；刷新失败保留上次成功数据。
- PerMonitorV2 DPI manifest、键盘快捷键、原生对话框与基础可访问性名称。

**工程与文档**
- 新增 `src/server/`、`src/domain/tasks.ts`、`src/calendar-actions.ts` 和完整 API 测试。
- 75 项自动化测试，覆盖本地 API、任务状态机、审批执行、知识 operation、设置和 worker 状态。
- 更新 `README.md`、`PRODUCT_DESIGN.md`、`docs/01`、`docs/03`、`docs/04` 和 `docs/api/openapi.yaml` 的实现状态。

### 验证

- `node --import tsx --test test/*.test.ts`：75 项通过。
- TypeScript 类型检查、`dist` 构建通过。
- WPF Debug/Release 构建通过，0 警告 0 错误。
- UI Automation 实测：五个页面、快速记录、`Ctrl+K` 面板均渲染；关闭后本地服务干净退出，无残留 node 进程。
- 隔离临时 `PERSON_AGENT_HOME` 端到端：快速记录创建任务 → 开始 → 完成，数据库状态为 `completed`。
- 真实环境启动：今日页使用真实天气/数据；Google 请求失败时正确进入 partial，本地数据仍显示。

### 运行

```powershell
pnpm build
$env:DOTNET_ROOT = "D:\person-agent\.dotnet"
$env:DOTNET_MULTILEVEL_LOOKUP = "0"
D:\person-agent\.dotnet\dotnet.exe run --project D:\person-agent\client\PersonAgent.Desktop
```

构建需要 .NET 8 SDK，运行需要 .NET 8 Desktop Runtime。本机系统只有 .NET 6 运行时，仓库内 `.dotnet/` 为本地验证用 SDK（已 gitignore）。

### 已知限制

- 旧 WinForms 录入程序、`demo/` 和 CLI 主流程尚未删除；README 已标记为迁移期旧入口。
- Windows 通知尚未深链到客户端对象，通知文字已引导到“今日 → 待审批”。
- 审批失败后暂无 UI 重试/历史列表；CLI `/approve` 和 `/api/approvals` 仍可重试。
- Agent 暂不返回引用对象，也不保存长期会话。
- 125%–200% DPI 的完整视觉验收尚未逐档执行。
- 验证未对真实 Google/DeepSeek/Zotero 执行外部写入；审批和知识整理使用注入的 fake 服务测试，生产路径复用现有领域代码。

### 下一步

1. 阶段 4：删除旧 WinForms、`demo/` 和面向普通用户的 `/approve` 说明；Windows 通知改为深链到新客户端对象。
2. 阶段 5：补齐 100%–200% DPI、长标题、空列表、失败重试、离线和交叉跳转验收；补充失败审批重试/历史。
3. 发布准备：决定 MSIX 或传统安装器，完善升级/回滚/备份手册。
