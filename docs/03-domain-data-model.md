# Person Agent 领域数据模型与状态机

> 文档状态：阶段 0 基线
>
> 数据库实现依据：`src/database.ts`
>
> API DTO 依据：`docs/api/openapi.yaml`
>
> 最后更新：2026-10-30

## 1. 目的与原则

本文记录当前真实数据结构，并冻结新客户端必须遵守的状态转换。数据库结构以代码迁移为准；本文用于设计、接口和测试对齐，不能替代迁移脚本。

原则：

1. SQLite 保存可查询的领域状态；不复制完整邮件、论文全文或 Calendar 数据。
2. Obsidian 保存长期 Markdown 内容；程序只更新受管区块，保留用户手写内容。
3. Zotero、Gmail 和 Google Calendar 是外部事实来源，不建立影子数据库。
4. 所有持久化时间使用 UTC ISO 8601；展示时使用配置时区。
5. UI 提交“操作”，领域层决定合法状态迁移；UI 不直接设置任意状态。

## 2. 存储总览

```text
lectures ───────< jobs ───────< job_runs
                         (job_id, scheduled_for 唯一)

research_tasks ── calendar_event_id ──> Google Calendar（外部，仅逻辑关联）
       │
       └── taskId 包含在 workflow_actions.payload_json

zotero_items ─── item_key ───> Zotero 本地 API（外部）
       │
       └── card_version ──────> Obsidian Papers/<item_key>.md

knowledge_sync_state          # Zotero 增量游标等键值状态
workflow_actions              # 固定 payload 的 Calendar 审批
agent_conversations ──< agent_messages
                       (conversation_id, sequence 唯一)
config.json                   # 用户配置，不在 SQLite
secrets.dpapi                 # 加密凭据，不在 SQLite
```

SQLite 当前使用：

- `PRAGMA foreign_keys = ON`
- `PRAGMA journal_mode = WAL`
- `PRAGMA busy_timeout = 5000`

## 3. 当前 SQLite 表

### 3.1 `lectures`

本地讲座和组会的真相来源。

| 字段 | 类型 | 约束/语义 |
| --- | --- | --- |
| `id` | TEXT | UUID，主键 |
| `title` | TEXT | 必填，领域层限制长度 |
| `start_at` | TEXT | UTC 时间，必填 |
| `end_at` | TEXT | 可空；非空时必须晚于开始时间 |
| `location` | TEXT | 可空 |
| `speaker` | TEXT | 可空 |
| `notes` | TEXT | 可空 |
| `requires_presentation` | INTEGER | `0/1` |
| `status` | TEXT | `active / cancelled` |
| `created_at` | TEXT | UTC |
| `updated_at` | TEXT | UTC |

创建讲座时，领域层同时建立提前 24 小时提醒；`requires_presentation=true` 时增加提前 72 小时提醒。取消讲座会禁用关联提醒。

### 3.2 `jobs`

提醒、讲座提醒和系统自动任务定义。

| 字段 | 类型 | 约束/语义 |
| --- | --- | --- |
| `id` | TEXT | 主键；系统任务使用稳定 ID |
| `kind` | TEXT | `reminder / lecture / briefing` |
| `source_id` | TEXT | 可空；讲座提醒指向 lecture ID |
| `title`、`body` | TEXT | 通知内容 |
| `schedule_json` | TEXT | `once / daily / weekly` 调度 JSON |
| `timezone` | TEXT | IANA 时区 |
| `next_run_at` | TEXT | 下次运行 UTC；禁用时可空 |
| `enabled` | INTEGER | `0/1` |
| `catchup_minutes` | INTEGER | 允许补发的分钟数 |
| `created_at`、`updated_at` | TEXT | UTC |

稳定系统任务：

| ID | 当前 kind | 默认时间 | 补发策略 |
| --- | --- | --- | --- |
| `daily-briefing` | `briefing` | 07:30 | 当日 120 分钟窗口 |
| `knowledge-digest` | `briefing` | 22:30 | 最近 7 天逐日补发 |

`knowledge-digest` 沿用 `briefing` kind 是当前兼容设计；首版不为此重建 jobs 表。

### 3.3 `job_runs`

每个计划发生时间的运行记录和幂等边界。

| 字段 | 类型 | 约束/语义 |
| --- | --- | --- |
| `id` | TEXT | UUID，主键 |
| `job_id` | TEXT | 外键到 `jobs.id` |
| `scheduled_for` | TEXT | 本次计划时间 UTC |
| `status` | TEXT | `claimed / delivered / failed / skipped` |
| `attempts` | INTEGER | 领取次数 |
| `error` | TEXT | 截断后的安全错误，可空 |
| `started_at` | TEXT | UTC |
| `completed_at` | TEXT | 可空，UTC |

唯一约束：`(job_id, scheduled_for)`。失败重试复用同一行，不创建新的逻辑运行。

### 3.4 `research_tasks`

本地任务的真相来源。

| 字段 | 类型 | 约束/语义 |
| --- | --- | --- |
| `id` | TEXT | UUID，主键 |
| `title` | TEXT | 必填 |
| `task_kind` | TEXT | `research / assignment / other` |
| `source_type` | TEXT | `manual / email` |
| `source_id` | TEXT | 邮件来源时保存 Gmail message ID |
| `deadline` | TEXT | 可空，UTC |
| `estimated_minutes` | INTEGER | 5–1440 |
| `priority` | TEXT | `low / medium / high` |
| `status` | TEXT | 见任务状态机 |
| `confidence` | REAL | 0–1；手动任务通常为 1 |
| `planned_start`、`planned_end` | TEXT | 同时为空或同时存在 |
| `calendar_event_id` | TEXT | Google Calendar 事件 ID，可空 |
| `created_at`、`updated_at` | TEXT | UTC |

不保存整封邮件。UI 只显示必要来源摘要；需要查看原文时再通过 Gmail 只读接口读取。

### 3.5 `workflow_actions`

Calendar 外部写入的审批快照。

| 字段 | 类型 | 约束/语义 |
| --- | --- | --- |
| `id` | TEXT | UUID，主键 |
| `kind` | TEXT | `calendar.create / calendar.update` |
| `payload_json` | TEXT | 审批时固定的执行参数 |
| `status` | TEXT | 见审批状态机 |
| `result_json` | TEXT | 执行结果，可空 |
| `error` | TEXT | 安全错误，可空 |
| `created_at` | TEXT | UTC |
| `approved_at` | TEXT | 可空，UTC |
| `executed_at` | TEXT | 可空，UTC |

相同 `kind + payload_json` 的 pending 操作会复用现有记录。执行前必须再次比较 kind 和完整 payload；不一致时拒绝执行。

### 3.6 `zotero_items`

Zotero 题录副本和本地分析状态。Zotero 仍是题录真相来源。

| 字段组 | 字段 | 语义 |
| --- | --- | --- |
| 标识 | `item_key`、`version`、`item_type` | Zotero key 为主键；version 用于增量同步 |
| 题录 | `title`、`creators_json`、`date_text`、`abstract`、`doi`、`url`、`tags_json` | Zotero 只读数据 |
| 全文 | `fulltext_state`、`last_fulltext_check_at` | `unknown / available / unavailable` |
| 分析 | `analysis_state`、`analysis_json`、`analyzed_at` | `pending / partial / complete` |
| 重试 | `analysis_attempts`、`analysis_error`、`analysis_next_attempt_at` | 分析与全文读取失败共用退避 |
| 卡片 | `card_version` | 已写入 Obsidian 卡片的 Zotero version；`-1` 表示未写入 |
| 时间 | `first_seen_at`、`updated_at` | UTC |

`complete + truncated` 不是数据库状态；它由 `analysis_state=complete` 且 `analysis_json.truncated=true` 推导。

### 3.7 `knowledge_sync_state`

通用键值状态。目前至少使用：

- `zotero.libraryVersion`
- `zotero.lastSyncAt`

不得在这里保存凭据或大段正文。

### 3.8 `agent_conversations`

桌面端 Agent 对话的索引与生命周期（v0.4.0）。

| 字段 | 类型 | 约束/语义 |
| --- | --- | --- |
| `id` | TEXT | UUID，主键 |
| `title` | TEXT | 可空；首条用户消息自动生成，用户可改 |
| `status` | TEXT | `active / archived`；归档只阻止继续提问 |
| `created_at` | TEXT | UTC |
| `updated_at` | TEXT | 每次追加消息或修改元数据时更新 |
| `last_message_at` | TEXT | 可空，用于列表排序与恢复 |

### 3.9 `agent_messages`

Agent 消息轨迹。这里保存的是 `pi-agent-core` 的 `AgentMessage` 原文，不是给 UI 用的摘要文本。

| 字段 | 类型 | 约束/语义 |
| --- | --- | --- |
| `id` | TEXT | UUID，主键 |
| `conversation_id` | TEXT | 外键指向 `agent_conversations(id)` |
| `sequence` | INTEGER | 会话内自增，`UNIQUE(conversation_id, sequence)` |
| `role` | TEXT | `system / user / assistant / toolResult` |
| `schema_version` | INTEGER | 当前为 1，读取时只做必要迁移 |
| `message_json` | TEXT | 完整 `AgentMessage`：文本、tool call、toolResult、usage、错误 |
| `created_at` | TEXT | UTC |

规则：

- 用户消息在调用模型前写入；assistant/toolResult 消息在本轮结束后同一事务追加。
- 不逐 token 写入；流中断时保存明确的 `stopReason=error` 消息，不把半条回复当成功。
- 尾部未完成的 tool call 在下一次 prompt 前被丢弃，避免畸形 transcript。
- 删除会话时同时删除消息；归档不等于删除。

## 4. 非 SQLite 数据

### 4.1 `config.json`

当前字段：

- `timezone`
- `briefingTime`
- `thinkingLevel`
- `knowledgeVaultPath`
- `knowledgeDigestTime`
- 可选 `location { city, latitude, longitude, timezone }`

**当前字段**：上述字段之外，已增加 `briefingEnabled` 与 `knowledgeDigestEnabled`（缺省 `true`）。领域层让配置和 `jobs.enabled` 保持一致；WPF 不直接改 jobs 表。

### 4.2 `secrets.dpapi`

当前 Windows 用户 DPAPI 加密的 Google OAuth 数据和可选 DeepSeek key。API 不返回密钥内容，只返回 `connected / expired / missing` 等连接状态。

### 4.3 Obsidian Vault

```text
Ideas/
Papers/<zoteroKey>.md
Daily/YYYY-MM-DD.md
```

Idea 只存在 Markdown，不额外写入 SQLite。论文卡片以 Zotero key 稳定命名。程序更新标记区块时必须保留标记外手写内容和自定义 properties。

## 5. 状态机

### 5.1 任务

```text
draft ────────────────> in_progress ─────> completed
  │                          │
  │ 审批执行成功             └───────────> cancelled
  ▼
planned ─────> in_progress ──────────────> completed
  │  │              │
  │  └──────────────┴────────────────────> cancelled
  │
  └─ Calendar 删除/冲突 ─> needs_replan
                              │
                              ├─ 新审批执行成功 ─> planned
                              ├─ 用户直接开始 ───> in_progress
                              └──────────────────> cancelled
```

规则：

- 新任务固定从 `draft` 开始。
- `planned` 必须同时具有 `planned_start`、`planned_end`、`calendar_event_id`。
- `planned` 只能由已审批 Calendar 操作成功后产生；普通 PATCH 不允许伪造。
- `needs_replan` 由 worker 检测到事件删除或冲突后产生。
- `completed`、`cancelled` 在首版是终态；重新打开留作后续能力。
- 当前 `AppDatabase.updateResearchTask` 技术上允许更宽的状态修改；HTTP 领域 service 必须收紧到上述迁移，后续再将约束下沉。

### 5.2 Calendar 审批

```text
pending ──用户确认──> approved ──执行器领取──> executing
   │                                             │
   └─用户拒绝──> rejected                       ├─成功──> executed
                                                 └─失败──> failed
                                                               │
                                               用户再次确认重试 ─┘
```

规则：

- `pending` 卡片必须显示执行目标和固定 payload。
- approve 请求不接收新的 payload。
- `claimWorkflowAction` 必须验证存储的 kind 和 payload 与执行参数完全一致。
- `executed` 与 `rejected` 为终态。
- `failed` 可以再次批准后重试；稳定 Calendar event ID 保证重试不重复创建。
- `GET /api/approvals/history` 返回 pending 以外的记录，失败优先、其余按创建时间倒序，默认 20 条、最多 50 条；客户端据此展示重试和追溯入口。

### 5.3 论文分析

```text
新条目/题录实质变化 ─> pending
pending ──全文成功────────────> complete
pending ──超长全文头尾采样────> complete + truncated
pending ──无全文但有摘要──────> partial
pending ──失败────────────────> pending + error + nextAttemptAt
partial ──之后发现全文────────> pending ─> complete
```

退避：

- 第 1 次失败：1 小时。
- 第 2 次失败：6 小时。
- 第 3 次失败：24 小时。
- 第 4 次及以后：72 小时。
- 每日分析额度优先新论文，并为重试保留最多一个槽位。

UI 推导状态：

| 条件 | UI 标签 |
| --- | --- |
| `pending` 且无 error | 待分析 |
| `pending` 且 nextAttemptAt 在未来 | 重试等待 |
| `partial` | 仅摘要 |
| `complete` 且 `truncated=false` | 全文 |
| `complete` 且 `truncated=true` | 头尾采样 |

### 5.4 定时任务运行

```text
（无记录）──领取──> claimed ──> delivered
                         ├────> skipped
                         └────> failed ──冷却后重新领取同一记录──> claimed
```

知识整理失败自动重试间隔为 1 小时、6 小时、24 小时；第 4 次失败后停止自动重试。`job_runs` 的 `(job_id, scheduled_for)` 唯一约束是幂等边界。

## 6. 领域不变量

以下条件必须由自动化测试覆盖：

1. Calendar 写入没有已批准 action 时无法执行。
2. 执行 payload 与审批快照不一致时无法执行。
3. `planned` 任务缺少计划时段或 Calendar ID 时无法保存。
4. 计划开始和结束时间同时为空或同时存在，且结束晚于开始。
5. Gmail message ID 可以保存，完整邮件正文不进入数据库。
6. Zotero 同步只读；游标只在卡片成功写入后推进。
7. Obsidian 标记外内容在重复同步和再分析后不改变。
8. 相同 scheduled occurrence 不产生第二条 `job_runs`。
9. 外部来源失败不回滚已经成功的本地读取结果。
10. 所有展示状态都能由持久化字段和明确规则推导，不保存纯 UI 标签。

## 7. `operations`（已实现）

手动 Zotero 同步、知识整理属于长任务。当前数据库没有可供 UI 查询的通用操作表；实现对应 API 前增加：

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `id` | TEXT | UUID，主键 |
| `kind` | TEXT | `knowledge.sync / knowledge.digest` |
| `status` | TEXT | `queued / running / succeeded / failed` |
| `stage` | TEXT | 当前阶段，如 `syncing / analyzing / writing` |
| `progress_current`、`progress_total` | INTEGER | 可空；仅有真实总量时填写 |
| `result_json` | TEXT | 可空 |
| `error` | TEXT | 可空，脱敏并截断 |
| `created_at`、`started_at`、`completed_at` | TEXT | UTC |

约束：同一时间最多有一个 `queued/running` 的知识 operation（`knowledge.sync` 与 `knowledge.digest` 互斥）。重复请求返回现有 operation，而不是启动第二次任务；不同 kind 的并发请求返回 409。

不要把 `setTimeout`、客户端进度条或内存 Promise 当成操作状态。

## 8. 索引与迁移规则

当前索引：

- `jobs_due_idx(enabled, next_run_at)`
- `research_tasks_status_idx(status, deadline)`
- `workflow_actions_status_idx(status, created_at)`
- `zotero_items_analysis_idx(analysis_state, first_seen_at)`
- `zotero_items_first_seen_idx(first_seen_at)`
- `operations_status_idx(status, created_at)`
- `agent_conversations_status_idx(status, updated_at)`
- `agent_messages_conversation_idx(conversation_id, sequence)`

迁移规则：

1. 迁移必须向前兼容已有用户数据库，不删除或重命名字段。
2. 新增非空列必须提供安全默认值，并补充旧库迁移测试。
3. 不使用“删除数据库重新生成”作为升级方案。
4. schema 变化、DTO 变化和测试必须在同一提交完成。
5. 发布前使用一份旧版本数据库副本完成升级、启动、读写和回滚演练。

## 9. 后续方向

### 阶段 1

- 不改现有表结构。
- 为 `/api/today` 增加领域聚合函数和任务状态转换 service。
- 为现有状态转换补充不变量测试。

### 阶段 2

- 增加 `operations` 表和迁移。
- 增加自动化 enabled 配置字段。
- 根据真实查询性能决定是否增加索引；不提前引入 FTS。

### 阶段 3

- 搜索规模确实需要时，再评估 SQLite FTS；Idea 仍以 Markdown 为真相来源。
- 会话持久化已在 v0.4.0 完成（`agent_conversations` / `agent_messages`）；后续再增加历史裁剪、摘要与长期记忆表，并保持删除即不可读取。

### 发布前

- 冻结数据库 schema 版本策略。
- 写升级/备份/回滚手册。
- 用真实旧库执行迁移测试，确认 Vault 手写内容和审批记录不丢失。
