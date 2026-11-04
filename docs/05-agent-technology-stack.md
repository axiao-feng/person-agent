# Person Agent 新增 Agent 能力技术栈

> 文档状态：P0–P2 的会话、Context Builder、长期记忆、Workflow Run、工具权限与回答引用均已实现（v0.4.0–v0.8.0）；知识检索工具、工作记忆与语义记忆待实现
>
> 对应需求：`PRODUCT_DESIGN.md` 第 16 节
>
> 原则：沿用现有技术栈，先补持久化和确定性边界，不引入通用 Agent 平台
>
> 最后更新：2026-11-04

## 1. 结论

新增的持久化会话、分层记忆、Context Builder、可恢复 Workflow、工具权限和回答引用，都可以在现有栈内完成：

| 层 | 采用技术 | 处理决定 |
| --- | --- | --- |
| Windows 客户端 | .NET 8、C# 12、WPF、MVVM | 保持现状，不增加桌面框架 |
| 客户端通信 | `HttpClient`、`System.Text.Json`、loopback HTTP、OpenAPI 3.1 | 扩展会话和 Workflow API |
| 本地服务 | Node.js 22、TypeScript 5.9、ESM、`node:http`、TypeBox | 增加 Session/Context/Workflow 模块 |
| Agent Runtime | `@earendil-works/pi-agent-core` 0.86、`@earendil-works/pi-ai` 0.86 | 复用消息恢复、`transformContext` 和工具事件 |
| 模型 | DeepSeek Flash | 对话、摘要和记忆候选继续使用同一模型；不增加模型路由 |
| 领域数据库 | Node 内置 `node:sqlite`、SQLite WAL | 新增会话、消息、记忆、Workflow 表 |
| 文本检索 | 结构化 SQL；需要时使用 SQLite FTS5 | 不引入向量数据库 |
| 后台执行 | 现有 Windows worker + Task Scheduler | 接管可恢复 Workflow 和长任务 |
| 权限与审批 | TypeScript 静态策略表 + `pi-agent-core` 工具钩子 + 现有固定 payload 审批 | 不引入独立策略引擎 |
| 安全 | DPAPI、loopback session token、日志脱敏 | 沿用现有边界 |
| 测试 | `node:test`、临时 SQLite、现有桌面合同测试 | 不增加测试框架 |

不建议引入 LangChain、LangGraph、Temporal、Redis、消息队列、ORM、独立向量数据库或第二个后端服务。当前是单用户、本机、低并发产品，这些组件只会增加部署和恢复路径。

## 2. 当前栈中可直接复用的能力

### 2.1 `pi-agent-core`

当前依赖已经提供：

- `AgentMessage[]` 形式的完整对话轨迹；
- 通过 `initialState.messages` 或 `agent.state.messages` 恢复消息；
- `transformContext`，可在每次模型请求前裁剪历史和注入外部上下文；
- `turn_end`、`message_end`、`tool_execution_end` 等事件；
- `beforeToolCall` / `afterToolCall` 权限与结果钩子；
- `sessionId`，可作为模型侧缓存标识；
- `continue()`，可从 user/toolResult 结尾继续执行。

因此不需要再包一层第三方 Agent Framework。

### 2.2 `pi-ai`

继续使用它提供的统一消息类型、模型 `contextWindow`、实际 token usage 和 DeepSeek provider。上下文预算以模型元数据和实际 usage 为依据，不维护第二份模型目录。

### 2.3 SQLite 与 worker

现有项目已经用 SQLite 持久化任务、审批、作业运行和长操作，并用 Windows worker 处理补发与恢复。新增 Agent 能力应复用同一数据库、事务模式和 worker，不增加 Redis 或独立进程管理器。

## 3. P0：持久化多轮会话（v0.4.0 已实现）

### 3.0 实现状态

- 数据模型：`agent_conversations`、`agent_messages` 落在 `src/database.ts` 的迁移块，配套 `createAgentConversation`、`appendAgentTranscript`、`listAgentTranscript`、`deleteAgentConversation` 等方法。
- 会话编排：新增 `src/agent/session.ts`，把“加载历史 → 先写用户消息 → 执行一轮 → 单事务追加结果”收敛为一个函数（`runConversationTurn`），配套 `loadConversationHistory` 与 `conversationAgentFactory`。
- API：`src/server/routes/conversations.ts` 提供 `/api/conversations*`；`/api/agent/messages` 作为兼容入口复用同一 `sendAgentTurn`。
- 客户端：`CommandPaletteViewModel` 持有 conversation ID 并恢复最近一次 active 对话，`LocalApiClient` 增加会话方法。
- 测试：`test/conversation.test.ts`（6 项）+ `test/api.test.ts` 会话用例（2 项）+ 2 项 WPF DTO 合同测试。
- 尚未做的 P0 收尾项：CLI `chat` 仍未写入会话表；保留策略是“用户手动删除”。

### 3.1 模块

新增最少三个 TypeScript 文件：

```text
src/agent/
  session-manager.ts    # 创建、加载、归档会话
  transcript-store.ts   # AgentMessage 持久化与恢复
  context-builder.ts    # P1 再实现，P0 可先透传完整历史
```

若两个持久化文件最终不足 150 行，可合并为 `session.ts`，不为目录结构而拆分。

### 3.2 数据模型

使用现有 SQLite，新增：

```text
agent_conversations
  id TEXT PRIMARY KEY
  title TEXT
  status TEXT                 # active / archived
  created_at TEXT
  updated_at TEXT
  last_message_at TEXT

agent_messages
  id TEXT PRIMARY KEY
  conversation_id TEXT REFERENCES agent_conversations(id)
  sequence INTEGER
  role TEXT
  message_json TEXT           # 完整 AgentMessage
  created_at TEXT
  UNIQUE(conversation_id, sequence)
```

`message_json` 保存 `AgentMessage` 的完整结构，包括 assistant tool call、toolResult、usage 和错误信息；`role` 只用于快速筛选。每条消息带 schema version，读取时只做必要迁移。

不单独设计 `sessions` 和 `conversations` 两套概念。桌面端的一条对话就是一个 conversation；运行中的模型调用是瞬时 request，不需要持久 session 表。

### 3.3 写入时机

- 用户消息在调用模型前持久化。
- `message_end` 后持久化完整 assistant/toolResult 消息。
- 一个 turn 的新增消息放在同一短事务中写入。
- 不逐 token 写 SQLite。
- 流中断时保存明确的 `aborted/error` 结果，不能把半条回复当成功回复。

### 3.4 API 与 WPF

扩展本地 API：

```text
POST   /api/conversations
GET    /api/conversations
GET    /api/conversations/:id/messages
POST   /api/conversations/:id/messages
PATCH  /api/conversations/:id              # 标题/归档
DELETE /api/conversations/:id              # 用户明确删除
```

WPF 继续使用现有 `HttpClient` 和 `System.Text.Json`。右侧 Agent 抽屉保存当前 conversation ID；重启后按最近更新时间恢复，不增加本地客户端数据库。

### 3.5 成功标准

- 连续两轮请求使用同一个 conversation ID。
- 关闭 WPF 和本地服务后重新打开，能继续同一对话。
- 工具调用和工具结果顺序不丢失。
- 删除会话后，消息与摘要都无法再被 Context Builder 或搜索读取。

## 4. P1：Context Builder 与历史摘要（v0.5.0 已实现）

### 4.0 实现状态

- `src/agent/tokens.ts`：保守估算，CJK 按字计、其余按 3 字符 1 token。
- `src/agent/context.ts`：`buildConversationContext` 组装每次请求，输出 `ContextManifest`；`contextTransform` 生成 `transformContext` 钩子，`createAssistant` 与测试共用同一路径。
- `src/agent/summary.ts` + `agent_summaries` 表：30 条积压触发、保留最近 10 条原文、可追溯覆盖范围、新摘要替代旧摘要。
- 预算：`promptBudgetTokens` 保留至少 25% 窗口（或模型 maxTokens）给输出与工具循环；工具声明按工具数估算。
- 日志：`agent_context` 只记录清单与 ID，不记录正文；摘要失败记录 `agent_summary_failed`。

### 4.1 实现位置

使用 `pi-agent-core` 的 `transformContext(messages, signal)`，不在 HTTP route 或 WPF 中拼 prompt。

Context Builder 按固定顺序组装：

```text
系统规则
→ 当前 Workflow/工作记忆
→ 已确认的长期记忆
→ 历史摘要
→ 最近原始消息
→ 当前任务检索到的本地证据
→ 当前用户消息
```

外部邮件、日历文本、论文内容始终带“不可信数据”边界，不能拼入 system rules。

### 4.2 Token 预算

- 总预算读取 `pi-ai` 模型的 `contextWindow`。
- 为输出和工具调用预留固定安全比例，首版建议至少 25%。
- 已完成请求使用 assistant message 中的真实 usage 记录校准。
- 请求前使用小型本地估算器做保守预估；不为首版增加 tokenizer 包。
- 连续出现 context length 错误或估算偏差超过 20% 时，再接入 DeepSeek 对应 tokenizer。

### 4.3 摘要

使用现有无工具 `generateText` 路径生成会话摘要，避免摘要文本触发工具。摘要需要保存：

- 覆盖的消息 sequence 范围；
- 摘要正文；
- 仍未解决的问题；
- 稳定对象引用；
- 生成时间和模型；
- 被新摘要替代的版本。

原始消息默认不因摘要而删除。摘要错误时回退到最近原始消息，不阻断会话。

### 4.4 调试记录

每次模型调用仅记录上下文来源清单和对象 ID，不在普通日志复制完整邮件、论文正文或私密消息。

## 5. P1：分层记忆（长期记忆 v0.6.0 已实现；工作记忆未实现）

### 5.0 实现状态

- `agent_memories` 表：kind、content、source、confidence、importance、valid_until、软删除。
- 写入只经两条路径：用户明确要求时的 `remember_user_fact` 工具，或设置页/API 手动新增；相同内容合并。
- 注入：每轮最多 20 条生效记忆，按重要度与更新时间排序，`ContextManifest.memoryIds` 记录本轮使用情况。
- 检索：kind / 关键词 / 有效期 SQL；未引入 FTS5 或向量库。
- 删除：软删除，列表与 Context Builder 都不再读取。
- 工作记忆（当前目标/步骤）仍未实现，将与持久 Workflow Run 一起设计。

### 5.1 三层映射

| 记忆层 | 技术实现 | 生命周期 |
| --- | --- | --- |
| 工作记忆 | 当前 conversation 的 `working_state_json`，或关联 Workflow run 的 checkpoint | 当前目标完成后清理/归档 |
| 短期记忆 | `agent_messages` + 可更新历史摘要 | 随会话保留策略清理 |
| 长期记忆 | `agent_memories` 结构化表 | 用户可查看、编辑、删除和失效 |

### 5.2 长期记忆表

```text
agent_memories
  id TEXT PRIMARY KEY
  kind TEXT                    # preference / fact / experience / correction
  content TEXT
  source_type TEXT             # explicit_user / conversation / domain_object
  source_id TEXT
  confidence REAL
  importance INTEGER
  valid_until TEXT
  created_at TEXT
  updated_at TEXT
  deleted_at TEXT
```

首版只保存以下内容：

- 用户明确要求“记住”的信息；
- 用户明确纠正过的稳定事实；
- 可追溯到具体消息的稳定偏好。

模型可以提出 memory candidate，但确定性代码负责去重、标来源和落库。不要自动把邮件、论文结论或一次性任务写成用户长期记忆。

### 5.3 检索

第一版使用 kind、source、有效期、重要度、时间和关键词 SQL 检索。当前 Node/SQLite 运行时已经支持 FTS5；只有当记忆规模或关键词排序需要时再增加 FTS5 虚表。

暂不引入 embedding 和向量数据库。满足以下任一条件后再评估：

- 有效长期记忆超过约 5,000 条；
- 关键词检索的离线召回率明显不足；
- 已建立可复现的记忆检索评测集。

## 6. P1：持久 Workflow Run（v0.7.0 已实现试点）

### 6.0 实现状态

- `workflow_runs` / `workflow_steps` 两张表落在 `src/database.ts` 的迁移块；`current_step` 表示已完成的步骤数。
- `src/workflows/registry.ts` 只注册显式定义的 workflow；当前唯一实现是 `task.schedule`（两步：生成审批 → 等待并检查审批）。
- `src/workflows/runtime.ts`：claim → 逐步执行 → waiting/poll/done/cancelled/failed；`poll` 表示步骤尚未满足，重新挂起并在下次 resume 重试。
- 幂等：每步执行前写入 `idempotency_key`，并先落库输入；重复推进复用已成功的步骤。
- 恢复：worker 每 30 秒调用 `resumePendingRuns`；`waiting_for_user` 直接检查，`running` 超过 5 分钟视为崩溃遗留并重新领取。
- 审批完成后本地服务立即 `resumeRunsForApproval`；Calendar 写入仍只经 `workflow_actions`。
- 未迁移：知识同步/整理仍使用 `operations`，按 docs 约定不重写稳定路径。

### 6.1 实现方式

不要建设“任意 Workflow DSL”。新增一个小型、显式注册的状态机运行时，只支持产品已有或已经批准的 workflow kind。

```text
src/workflows/
  runtime.ts          # claim / execute-next / wait / resume / cancel
  registry.ts         # workflow kind 到 handler 的静态映射
  types.ts
```

每个 handler 是普通 TypeScript 函数，输入为已验证的 checkpoint，输出为下一状态。模型可以建议计划，但不能直接改 run 状态或构造未注册步骤。

### 6.2 数据模型

```text
workflow_runs
  id TEXT PRIMARY KEY
  conversation_id TEXT
  kind TEXT
  status TEXT          # queued/running/waiting_for_user/succeeded/failed/cancelled
  input_json TEXT
  state_json TEXT
  current_step INTEGER
  created_at/updated_at/completed_at TEXT

workflow_steps
  id TEXT PRIMARY KEY
  run_id TEXT REFERENCES workflow_runs(id)
  sequence INTEGER
  kind TEXT
  status TEXT          # pending/running/succeeded/failed/skipped
  input_json/output_json/error TEXT
  idempotency_key TEXT
  started_at/completed_at TEXT
  UNIQUE(run_id, sequence)
  UNIQUE(idempotency_key)
```

只有在确实需要多步骤回滚时再增加独立 checkpoint 表；首版 `workflow_runs.state_json + workflow_steps.output_json` 已足够恢复。

### 6.3 执行位置

- Windows worker 领取 `queued/running` run，保证 WPF 或本地 HTTP 服务退出后仍能继续。
- `waiting_for_user` 不占用运行线程；用户响应后把 run 重新置为 queued。
- 每一步先持久化输入和幂等键，再执行副作用，最后保存输出。
- Calendar 外部写入仍复用 `workflow_actions`，Workflow runtime 不绕过审批。

现有 knowledge `operations` 暂不迁移到通用 Workflow。先完成一个真实需要断点恢复的新流程，再决定是否合并，避免为了统一而重写稳定路径。

## 7. P2：工具权限与审批策略（v0.8.0 已实现）

### 7.0 实现状态

- `src/tool-policy.ts`：每个已注册工具都有静态 `{risk, approval}`；风险为 `read / local_write / external_write`，审批为 `none / confirm / fixed_payload`。
- `createAssistant` 注入 `beforeToolCall`，调用 `authorizeToolCall`：未注册策略的工具被阻止并返回错误工具结果；外部写入若未声明固定 payload 审批也会被阻止。
- 策略表与 `buildTools` 注册的工具由测试保证一一对应，提示词与路由无法绕过。
- 未做：按任务/风险动态开放工具、用户可配置的确认级别、知识检索/整理工具（仍通过独立 API 与确定性任务触发）。

### 7.1 静态策略注册表

在工具定义旁维护 TypeScript 常量：

```typescript
type ToolPolicy = {
  risk: "read" | "local_write" | "external_write";
  approval: "none" | "confirm" | "fixed_payload";
};
```

策略由 `beforeToolCall` 强制执行，route、CLI 和模型提示词不能覆盖。建议默认：

| 类型 | 示例 | 默认策略 |
| --- | --- | --- |
| read | 查邮件、日历、天气、论文 | 直接执行 |
| local_write | 任务、Idea、讲座、提醒 | 按当前产品规则直接执行并回显 |
| external_write | Calendar create/update | 固定 payload 审批 |
| disabled | Gmail send/reply、未知外部写入 | 不注册工具 |

不引入 OPA、Casbin 或数据库驱动策略。只有出现多用户、管理员策略或多租户时才需要外部策略引擎。

### 7.2 知识工具

论文搜索、Zotero 同步和知识整理工具直接调用现有领域函数，不从 Agent 内部回调本地 HTTP API。同步/整理继续创建持久 operation，并遵守互斥和限流。

## 8. P2：回答引用与可追溯性（v0.8.0 已实现）

### 8.0 实现状态

- 工具结果可带结构化 `references`；`jsonResult(value, references)` 统一注入。
- `src/agent/references.ts` 从本轮 toolResult 收集、去重、按类型复核（SQLite；idea 检查 Vault 文件），最多 20 条。
- 会话轮次返回真实引用，`/api/agent/messages` 与 `/api/conversations/:id/messages` 不再返回空数组。
- WPF 面板展示引用标签并可跳转到任务、论文、讲座、Idea。
- 未做：Gmail message ID 与 Zotero 全文片段引用；审批引用的客户端深链。

### 8.1 引用来源

引用只能来自本轮实际执行的检索或工具结果：

- task ID；
- Zotero item key；
- Idea relative path；
- lecture ID；
- approval ID；
- Gmail message ID（需要新增受控引用类型时再扩展 OpenAPI）。

### 8.2 收集方式

工具返回统一的结构化 `references` 元数据。Agent 运行结束后，响应层从实际 toolResult 消息中收集、去重并再次验证对象存在，再填入 OpenAPI 的 `AgentReference[]`。

模型正文可以使用引用编号，但不能自行产生引用 ID。不存在或本轮未读取的对象不得作为引用返回。

不引入独立 provenance 服务；SQLite 对象 ID、工具轨迹和现有日志已足够形成首版证据链。

## 9. WPF 客户端增量

继续使用现有无第三方框架的 MVVM：

- `ObservableCollection` 展示消息和会话；
- `AsyncRelayCommand` 发送、继续、归档和删除；
- `LocalApiClient` 扩展 conversation/workflow 方法；
- `System.Text.Json` 解析 DTO；
- 当前命名管道只负责单实例和深链，不承载 Agent 数据通道；
- 长任务和 workflow 状态继续轮询，本阶段不增加 WebSocket/SignalR。

当轮询造成可测量的延迟或负载问题时，再评估 Server-Sent Events；不要同时引入 WebSocket 和流式模型输出。

## 10. 安全与数据保留

- session token、DPAPI、Google OAuth scope 和 loopback 限制保持不变。
- conversation、memory 和 workflow API 全部要求现有 session token。
- 日志只记录 conversationId、runId、stepId 和引用 ID，不记录完整私人内容。
- 会话和记忆必须提供删除能力；删除会话时消息与摘要一并删除，删除后 Context Builder 不得再读取。
- 归档不等于删除。
- 默认保留期先设为“用户手动删除”；有真实磁盘或隐私需求后再增加自动清理策略。
- 邮件和论文全文仍不复制进长期记忆或普通消息摘要。

## 11. 测试栈与验收

继续使用：

- Node `node:test` + `assert`；
- 每个测试独立临时 SQLite；
- faux/固定模型响应验证 Context Builder；
- 现有 `PersonAgent.Desktop.Tests` 做 DTO 和 ViewModel 合同测试。

最低新增测试：

1. 两轮对话和进程重启恢复。
2. assistant tool call 与 toolResult 序列化往返一致。
3. Context Builder 在预算内保留系统规则、当前问题和待处理工具结果。
4. 摘要只覆盖声明的 sequence 范围。
5. 删除记忆后无法检索。
6. Workflow 在 `waiting_for_user` 和进程重启后继续。
7. 同一 step idempotency key 不重复执行副作用。
8. 未批准的 external_write 工具无法执行。
9. 引用只来自实际工具结果，伪造 ID 被丢弃。

重试、队列和恢复路径不能只做单元测试；仍需临时数据库的真实调用链复现。

## 12. 实施顺序

### 第一批：P0 会话闭环（v0.4.0 已完成）

1. `agent_conversations`、`agent_messages` 迁移和仓储方法。
2. Session Manager 加载/保存 `AgentMessage[]`。
3. conversation API 与 WPF 会话恢复。
4. 进程重启端到端测试。

### 第二批：P1 上下文与记忆

1. `transformContext` 接入 Context Builder。（v0.5.0 已完成）
2. 历史裁剪和可追溯摘要。（v0.5.0 已完成）
3. 显式长期记忆及查看、编辑、删除。（v0.6.0 已完成）
4. 基于真实用例建立上下文/记忆评测，再决定是否启用 FTS5。（待实现）

### 第三批：P1 Workflow 恢复

1. 只选择一个确实需要等待用户和恢复的流程做 pilot。（v0.7.0 已完成：`task.schedule`）
2. 实现 run/step/idempotency 与 worker 领取。（v0.7.0 已完成）
3. 通过后再迁移第二个流程；不要一次改写现有稳定流程。（待实现）

### 第四批：P2 权限与引用

1. 抽取静态 ToolPolicy 并覆盖现有工具。（v0.8.0 已完成）
2. 补知识检索/整理工具。（待实现）
3. 从实际 toolResult 生成 AgentReference。（v0.8.0 已完成）

## 13. 何时升级技术栈

| 触发条件 | 再考虑的技术 |
| --- | --- |
| 记忆超过约 5,000 条且 SQL 关键词召回不足 | SQLite FTS5，然后才评估 embedding |
| 多进程高频争用使 SQLite busy 持续发生 | 单写入队列；多用户后才考虑 PostgreSQL |
| Workflow 数量和依赖图明显复杂、需要分布式执行 | 再评估 Temporal/LangGraph 类框架 |
| 多用户、组织级权限和管理员策略 | 外部身份系统与策略引擎 |
| 轮询导致可测量延迟或资源问题 | SSE；仍不默认使用 WebSocket |
| 安装和升级成为主要故障源 | 冻结 MSIX/安装器方案，不改变业务栈 |

在这些触发条件出现前，保持单机、单库、单 worker、显式状态机是更可靠的方案。

