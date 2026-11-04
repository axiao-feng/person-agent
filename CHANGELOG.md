# 更新日志

## v0.6.0 — 2026-11-04

实现 §16.8 的 P1：分层记忆中的长期记忆，从有来源、可编辑、可删除开始。

### 新增

**长期记忆数据与检索**
- SQLite 新增 `agent_memories`：`kind`（偏好/事实/经验/纠正）、内容、来源类型与来源 ID、置信度、重要度、失效时间、软删除时间。
- 同一 `kind` 下规范化内容相同的生效记忆会合并并提升重要度，不重复新建。
- 检索使用结构化 SQL：按 kind、关键词、有效期过滤，按重要度与更新时间排序；暂不引入 FTS5 或向量检索。
- 删除为软删除：行保留用于审计，但列表、搜索与 Context Builder 都不再读取。

**Agent 与上下文**
- 新增工具 `remember_user_fact`，只在用户明确要求记住或明确纠正时调用；briefing/knowledge 模式不注册任何工具。
- 系统提示新增第 14 条，明确禁止把邮件、论文结论或一次性任务写成长期记忆，且模型没有删除或修改记忆的工具。
- 每轮对话最多注入 20 条生效记忆（按重要度与更新时间），`ContextManifest.memoryIds` 记录本轮实际使用的记忆 ID。

**API 与客户端**
- 新增 `GET/POST /api/memories`、`PATCH/DELETE /api/memories/:id`；重复内容返回 200 与 `created=false`，重复删除幂等。
- 设置页新增“长期记忆”分区：按类型添加、查看、编辑、删除，删除后立即从上下文消失。

**测试与文档**
- 新增 `test/memory.test.ts`（5 项）与 2 项 API 测试、1 项会话注入测试、1 项 WPF 合同测试。
- OpenAPI 增加记忆合同；`PRODUCT_DESIGN.md` §16.2/§16.3/§16.8、`docs/03/04/05` 与 README 同步更新。

### 验证

- `pnpm test`：103 项通过（v0.5.0 为 95 项）。
- `pnpm test:desktop`：7 项通过。
- TypeScript 类型检查与 `dist` 构建通过；WPF Debug 构建 0 警告 0 错误。
- UI Automation 实测：隔离数据库预置一条记忆后启动客户端，设置页显示“长期记忆”分区、记忆内容、“偏好 · 重要度 5”元信息与编辑/删除按钮。

### 已知限制

- 记忆候选仍由模型在明确请求时提出，没有自动候选抽取与冲突消解；重要度默认 3，需要用户调整。
- 记忆检索是关键词 SQL，没有语义检索与记忆评测集。
- 工作记忆（当前目标/步骤）仍未实现；持久 Workflow Run 在下一批次。

## v0.5.0 — 2026-11-04

实现 §16.8 的 P1：Context Builder（token 预算、历史裁剪、可追溯摘要）。

### 新增

**上下文组装**
- 新增 `src/agent/tokens.ts`：保守的本地 token 估算（CJK 按字计、其余按 3 字符 1 token），不引入 tokenizer 依赖。
- 新增 `src/agent/context.ts`：`buildConversationContext` 按 `系统规则 → 历史摘要 → 已确认长期记忆 → 最近消息` 组装每次模型请求；预算扣除工具声明与输出预留；裁剪只会落在用户轮次边界，不会留下孤立 toolResult。
- 输出预留至少为模型窗口的 25%（或模型 maxTokens），由 `promptBudgetTokens` 统一计算。
- 上下文紧张时先丢弃摘要与记忆注入，再丢弃历史，当前问题始终保留。
- 每次请求产出 `ContextManifest`（预算、估算 token、保留/丢弃消息数、摘要 ID、记忆 ID），服务端写入 `agent_context` 日志，不记录正文。

**历史摘要**
- 新增 `agent_summaries` 表：覆盖的 sequence 范围、摘要正文、未解决问题、引用、模型、被替代版本。
- `src/agent/summary.ts`：当积压消息超过 30 条时，用无工具的 `generateText` 路径压缩前段对话并保留最近 10 条原文；摘要失败只记录错误，不影响本轮回答，也不删除原始消息。
- 摘要通过 `transformContext` 注入，并在下一轮复用。

**测试与文档**
- 新增 `test/context.test.ts`（8 项）与 2 项会话级测试：预算裁剪、toolResult 边界、摘要注入与预算紧张时丢弃注入、摘要覆盖范围与版本替代、摘要失败不影响回答。
- `PRODUCT_DESIGN.md` §16.1–§16.3、`docs/01/03/05` 与 README 同步更新。

### 验证

- `pnpm test`：95 项通过（v0.4.0 为 85 项）。
- `pnpm test:desktop`：6 项通过。
- TypeScript 类型检查与 `dist` 构建通过；WPF Debug 构建 0 警告 0 错误。

### 已知限制

- 未配置 DeepSeek key，真实模型下的摘要生成未实测；摘要器由注入的 fake 生成器覆盖。
- 长期记忆仍是空注入位；记忆表与检索在下一批次实现。
- 触发阈值（30/10）是固定常量，尚未按真实使用情况调优。

## v0.4.0 — 2026-11-04

实现 `PRODUCT_DESIGN.md` §16.8 的 P0：桌面端 Agent 会话与消息持久化，关闭客户端或本地服务后仍能继续同一对话。

### 新增

**会话与消息持久化**
- SQLite 新增 `agent_conversations`、`agent_messages`：保存标题、归档状态、最后消息时间，以及每条 `AgentMessage` 的完整 JSON（含 assistant tool call、toolResult、usage 和错误）。`UNIQUE(conversation_id, sequence)` 保证轨迹顺序，`schema_version` 留给后续迁移。
- 新增 `src/agent/session.ts`：`runConversationTurn` 先按会话加载历史，在模型调用前持久化用户消息，再在本轮结束后用单个事务追加 assistant/toolResult 消息。
- 首条用户消息自动生成会话标题；工具调用与工具结果原样往返；尾部未完成的 tool call 在下一轮前被丢弃，避免把畸形 transcript 交给模型。
- 模型失败时保存 `stopReason=error` 的 assistant 消息并返回明确错误，不再把上一轮回答当成本轮结果。

**本地 API**
- 新增 `POST/GET /api/conversations`、`GET/POST /api/conversations/:id/messages`、`PATCH/DELETE /api/conversations/:id`。
- `POST /api/agent/messages` 保留为兼容入口，现在会读取 `conversationId`、返回 `conversation` 与本轮 `messages`，不再每次生成新的随机 ID。
- 会话接口沿用 loopback + session token；不存在的会话返回 404，归档会话追加消息返回 409，模型不可用返回 503。

**WPF 客户端**
- `Ctrl+K` 面板的 Agent 区改为多轮对话：展示用户 / Agent / 工具结果消息轨迹和当前对话标题，并提供“新对话”“删除对话”。
- 打开面板时按最近更新时间恢复最近一次 active 对话并滚动到最新消息；关闭客户端或本地服务后重新打开仍能继续。
- 新增会话 DTO 与 `LocalApiClient` 会话方法，删除会话前要求二次确认。

**测试与文档**
- 新增 `test/conversation.test.ts`（6 项）与 API 会话测试（2 项），覆盖两轮对话、进程重启恢复、工具消息往返、悬空 tool call 裁剪、失败轮次、归档与删除。
- 新增 2 项桌面合同测试（会话轨迹与回答 DTO 解析），桌面合同测试共 6 项。
- `docs/api/openapi.yaml` 增加会话合同；`PRODUCT_DESIGN.md` 增加阶段 6 并更新 §16.1 的已实现状态。

### 验证

- `pnpm test`：85 项通过（v0.3.1 为 78 项）。
- `pnpm test:desktop`：6 项通过。
- TypeScript 类型检查与 `dist` 构建通过；WPF Debug 构建 0 警告 0 错误。
- 使用隔离 `PERSON_AGENT_HOME` 启动真实 `serve` 进程实测：创建会话 → 追加消息（本机未配置 DeepSeek key，按设计先落库用户消息再返回 503）→ 读取轨迹 → 归档 → 删除 → 再次读取返回 404。
- UI Automation 实测：在隔离数据库中预置一条历史对话后启动客户端，`Ctrl+K` 打开面板即显示“继续：恢复测试对话”、用户消息与 Agent 回答，`新对话` / `删除对话` 可用；关闭后无残留进程。

### 已知限制

- 本机未配置 DeepSeek key，未执行真实模型的两轮对话实测；多轮 replay 由 faux 模型测试覆盖。
- 历史裁剪、历史摘要、长期记忆、持久 Workflow Run、工具权限策略和回答引用仍按 §16.8 的 P1/P2 顺序未实现。
- CLI `chat` 仍是进程内会话，不写入 `agent_conversations`。

## v0.3.1 — 2026-10-31

修复 v0.3.0 验收发现的通知深链与后台任务问题。

### 修复

**通知深链跨进程目录**
- `serve` 的就绪消息新增 `home` 字段，返回后台服务实际使用的应用目录（已加载仓库 `.env`）。
- WPF 客户端在后台启动后，把 `desktop.json` 同时写入服务实际目录和 `%LOCALAPPDATA%\person-agent`；不再只依赖客户端进程环境。
- worker 查找登记文件时先查自身应用目录，再回退到标准 LocalAppData 目录；任一登记路径可执行文件失效时继续尝试下一个。
- 修复了之前 `.env` 设置 `PERSON_AGENT_HOME=D:\person-agent\.data` 而客户端登记到 LocalAppData 导致通知按钮消失的问题。

**后台任务持续运行**
- 计划任务改为“登录触发 + 每 5 分钟重复触发”；`IgnoreNew` 防止重复实例，进程意外退出后最多 5 分钟自动恢复。
- `worker status` 不再直接输出本地化的 `schtasks` 文本，改为结构化状态、上次运行时间和上次结果（如 `0xC000013A`），解决中文 Windows 乱码。
- 本机已重新执行 `worker install`，任务当前为 Running，重复触发间隔 5 分钟。

**测试**
- 新增 `client/PersonAgent.Desktop.Tests` 合同测试（4 项），覆盖深链参数、协议 URI、单实例 payload 和客户端登记文件。
- 新增通知目录回退、服务就绪目录、worker 重复触发和状态格式测试。

### 验证

- `node --import tsx --test test/*.test.ts`：78 项通过。
- `pnpm test:desktop`：4 项通过。
- TypeScript 类型检查、构建通过；WPF Debug 构建 0 警告 0 错误。
- 实测正常启动客户端（无 `PERSON_AGENT_HOME` 环境变量）后，`.data` 和 LocalAppData 均生成 `desktop.json`；worker 环境可解析到客户端 exe。
- 实测 `worker install` 后任务 Running，触发器中包含 `PT5M` 重复间隔；`worker status` 输出中文可读。

### 升级注意

- 升级后需要重新运行一次 `person-agent worker install`，让计划任务写入每 5 分钟重复触发；当前机器已执行。

## v0.3.0 — 2026-10-31

完成唯一入口切换，并补齐 Windows 通知深链与审批失败重试/历史。

### 新增

**通知深链与单实例**
- 客户端启动时把自身路径登记到应用目录的 `desktop.json`。
- Windows 通知新增“打开待审批”“打开今日”“打开日历”按钮；后台任务把审批 ID、讲座 ID 或今日入口随通知一并传递。
- WPF 客户端保持单实例：再次启动时通过命名管道把 `--approval <ID>` / `--lecture <ID>` / `--today` 转发给已打开的窗口，并自动聚焦对应页面或对象。
- 通知中的审批深链同时支持 pending 和 failed 记录；找不到对象时显示明确提示。

**审批历史与失败重试**
- 新增 `GET /api/approvals/history?limit=20`，返回 pending 以外的审批记录，失败记录优先，默认 20 条、最多 50 条。
- 今日页新增“审批历史”分区，展示执行失败、已执行和已拒绝记录及错误信息。
- 失败记录可在详情面板中按原 payload 重试写入 Calendar，也可以忽略；执行参数仍由持久化 payload 决定，客户端不能篡改。
- 审批完成后详情面板会同步刷新最新状态与错误。

**工程**
- 删除旧 WinForms 启动器、`launcher/`、`demo/` 及其测试与 CLI `launcher install` 命令。
- README、产品设计、架构和 UI 合同更新为单一 WPF 入口。
- 版本号更新为 0.3.0（`package.json`、WPF 项目、OpenAPI）。

### 验证

- `node --import tsx --test test/*.test.ts`：76 项通过。
- TypeScript 类型检查与 `dist` 构建通过。
- WPF Debug 构建通过，0 警告 0 错误。
- UI Automation 实测：待审批与失败审批深链均打开对应详情；审批历史显示错误、状态和重试/忽略按钮；通知弹窗按钮可启动客户端并转发深链。
- 单实例实测：连续启动 3 个带深链的客户端实例均在约 1 秒内退出，主窗口收到 `deep_link_received` 与 `deep_link_opening` 事件。
- 失败重试实测：在未配置 Google 的环境中点击“重试写入”，客户端调用审批接口后正确显示“Google 尚未连接”并把记录保留为 failed。

### 升级注意

- `person-agent launcher install` 已移除。已创建的旧桌面/开始菜单快捷方式需要手动删除，改为启动 `client/PersonAgent.Desktop`；旧 `launcher/bin/` 可由用户自行清理。
- 通知深链需要至少启动一次新客户端以写入 `desktop.json`；若客户端未登记或可执行文件不存在，通知只显示文字说明，不显示打开按钮。
- 运行 WPF 客户端仍需要 .NET 8 Desktop Runtime；仓库内 `.dotnet` 仅用于本地构建和验证。

### 已知限制

- 125%–200% DPI 的逐档视觉验收、Windows 11 焦点/对比度检查尚未完成。
- 发布方式（MSIX 或传统安装器）与升级/回滚/备份手册尚未确定。
- 验证未对真实 Google 执行外部写入；失败重试路径在未配置 Google 的环境中验证，成功重试由注入的 fake executor 自动化测试覆盖。

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
