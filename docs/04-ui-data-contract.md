# Person Agent UI—真实数据合同

> 文档状态：阶段 0 基线
>
> 目的：冻结可见字段、动作与真相来源
>
> 参考：`PRODUCT_DESIGN.md`、已删除的 `demo/`（v0.3.0）
>
> 最后更新：2026-10-31
>
> 实现状态：S1–S4 合同已由 `client/PersonAgent.Desktop` 接入真实数据；阶段 4 的旧入口删除和通知深链已完成，阶段 5 的审批失败重试/历史已完成，高 DPI 逐档视觉验收待执行。

## 1. 使用方法

本文不是视觉稿，而是 UI 与后端之间的可验证合同。每个可见数字、标签和按钮必须满足以下之一：

- 有明确真实数据源和计算规则；
- 明确显示为 unavailable/尚未计算；
- 明确退出或延期。

状态标记：

- **S1**：阶段 1“今日”页原型。
- **S2**：阶段 2 其余页面和本地写入。
- **S3**：阶段 3 审批、搜索和 Agent。
- **S4**：阶段 4 通知深链、审批历史和失败重试。
- **退出**：旧 demo 中存在，但不进入正式客户端。
- **延期**：有价值但缺少可靠合同，首版不显示。

## 2. 全局规则

### 2.1 页面加载状态

每个独立模块使用统一状态：

| 状态 | 表现 |
| --- | --- |
| `idle` | 尚未请求或等待用户动作 |
| `loading` | 首次加载，显示骨架；不显示旧的模拟值 |
| `refreshing` | 保留上次成功数据，标记“正在更新” |
| `success` | 显示数据和 `generatedAt/refreshedAt` |
| `empty` | 显示真实空状态和下一步入口 |
| `partial` | 显示可用数据，并逐项指出失败来源 |
| `error` | 本模块失败；保留重试和诊断入口 |

刷新失败不得清空此前成功数据。请求未完成前不得提前显示成功。

### 2.2 时间与数字

- API 时间为 UTC RFC 3339；UI 按响应中的 IANA `timezone` 展示。
- “今天”“本周”使用配置时区，不使用 WPF 进程隐含时区。
- 数量来自响应数组或服务端明确统计，不解析界面文本计算。
- 相对时间旁必须可查看绝对时间；超过一天默认显示绝对日期。
- 没有可靠分母时不显示百分比、趋势或“提升”。

### 2.3 动作反馈

- 按钮提交后只禁用当前动作，不锁死整页。
- 成功以服务端返回对象为准，并刷新受影响模块。
- 错误保留在对象或表单附近；toast 只作辅助提示。
- Calendar approve 不允许客户端提交或修改 payload。
- 危险或外部写入动作显示目标、影响和确认结果。

## 3. 全局框架

| UI 元素 | 数据/动作合同 | 阶段 | 空/失败处理 |
| --- | --- | --- | --- |
| 左侧导航徽标 | 知识库徽标=`pending/retrying` 论文数；任务徽标=`draft/needs_replan` 数；无待处理时隐藏 | S2 | 不显示硬编码数字 |
| `Ctrl+K` | 打开命令面板；搜索结果与 Agent 回答分区 | S3 | 服务不可用时只保留快速记录入口 |
| 通知/审批入口 | `GET /api/approvals?status=pending` 的数量 | S3 | 0 时不显示红点 |
| 快速记录 | Idea/任务/讲座三种独立表单 | S2 | 保存失败保留用户输入 |
| 底部服务状态 | `/api/health.status` 与各 connection 状态 | S1 | `unknown` 不得显示为“正常” |
| 用户姓名/头像 | 首版没有账号资料来源 | 退出 | 删除 demo 的“林同学”和头像 |
| “模拟数据”标记 | 仅 demo 使用 | 退出 | 正式客户端不得出现 |

## 4. 今日页（S1）

阶段 1 只实现“下一件事 + 时间线 + 今日知识流摘要 + 待审批只读卡”。不恢复网页式 Hero 和四张装饰统计卡。

### 4.1 页头

| 可见内容 | 真实来源/规则 | 失败或空状态 |
| --- | --- | --- |
| 日期、星期 | `/api/today.date` + `timezone` | 本地服务不可用时显示系统日期，但标记“数据未加载” |
| 问候 | 由展示时段固定生成：05–11 早上好、12–17 下午好、其余晚上好 | 不调用模型 |
| 数据更新时间 | `generatedAt` | 无响应时显示“尚未更新” |
| 天气 | `sources.weather` 与 `weather.current` | 单独显示“天气暂不可用”，不阻断任务 |
| 城市 | 配置的 location.city | 未配置时显示“未配置城市”入口 |
| 穿搭建议 | 阶段 1 没有确定性规则 | 延期；不从 demo 复制 |

### 4.2 今日重点

| 可见内容 | 真实来源/规则 |
| --- | --- |
| 最多三项重点 | `/api/today.focusItems`，服务端按固定顺序选择 |
| 标题 | 对应任务或讲座标题 |
| 原因 | 服务端返回的 `reasonCode` 映射为“进行中 / 已安排 / 今天截止 / 高优先级”等可解释文字 |
| 时间 | 计划时间、deadline 或讲座时间；没有时不虚构 |
| 开始 | S2 对 task 发 `PATCH /api/tasks/{id}`，operation=`start`；S1 暂不显示动作 |
| 完成 | S2 对 task 发 operation=`complete`；S1 暂不显示动作 |

阶段 1 排序规则：

1. `in_progress` 任务；
2. 今天已计划且尚未完成的任务，按开始时间；
3. 已逾期或今天截止的任务，按 deadline；
4. 其他高优先级 draft/needs_replan 任务，按 deadline、创建时间；
5. 不足三项时可以加入 `requiresPresentation=true` 的今日讲座。

模型可以在后续润色摘要，但不能改变入选对象；响应必须保留 `reasonCode`。

空状态：显示“今天暂时没有需要处理的重点”，提供“快速记录”和“查看待安排任务”，不生成鼓励式虚构内容。

### 4.3 时间线

| 类型 | 来源 | 展示字段 | 去重/状态规则 |
| --- | --- | --- | --- |
| Google 事件 | Calendar API | title、start/end、allDay、status | 外部读取失败时该来源缺失并标记 partial |
| 本地讲座 | `lectures` | title、time、location、speaker、requiresPresentation | cancelled 不显示 |
| 已计划任务 | `research_tasks` | title、plannedStart/End、status | 有 `calendarEventId` 且对应事件已返回时合并为一个条目 |
| 自动任务 | `jobs` | title、nextRunAt、最近结果 | 只显示与当天相关的 07:30/22:30 系统任务 |
| 待审批时段 | `workflow_actions` | title、proposed start/end | 显示橙色虚线，不算已安排 |

所有条目按全天事件、开始时间排序。没有时间线条目时显示“今天暂时没有已安排事项”。

### 4.4 今日知识流

| 可见内容 | 来源/规则 |
| --- | --- |
| 最近论文 | `zotero_items` 中当天新见或当天更新的最多 5 篇 |
| 状态 | 由 analysis/fulltext 字段推导，见数据模型 |
| 研究方向/结果摘要 | 只在已有 `analysis` 时显示 |
| 立即整理 | S2；创建长任务 operation，不能在客户端模拟 |
| 自动执行说明 | settings 中的 knowledgeDigest enabled/time |

若 Zotero 不可用但已有本地数据，继续显示本地数据并标记“未能刷新”。

### 4.5 待审批卡

S1 只读展示 pending 审批，S3 才开放 approve/reject。

必须显示：

- action kind 与外部目标 `Google Calendar`；
- 任务标题；
- 原时间（存在时）；
- 建议时间；
- 冲突/变更原因；
- 创建时间；
- “尚未写入 Calendar”状态。

不得把 pending 操作渲染成成功事件。

### 4.6 从 demo 退出的内容

`demo/` 已在 v0.3.0 删除；下表保留为字段取舍记录。

| 旧 demo 内容 | 决定 | 原因 |
| --- | --- | --- |
| 大面积 Hero、轨道图 | 退出 | 不影响决策，占用桌面空间 |
| “本周 +12%” | 退出 | 无定义分母和业务意义 |
| 任务 `4/6`、65% 专注进度 | 退出 | 当前领域模型没有进度字段 |
| “3.5 小时可用专注时间” | 延期 | 需先冻结工作时段、全天事件和边界规则 |
| 模型生成的宏观鼓励文案 | 延期 | 先保证对象与来源可追溯 |

## 5. 知识库页（S2）

### 5.1 列表和筛选

| UI 字段 | 数据源 | 计算/显示规则 |
| --- | --- | --- |
| 标题 | `zotero_items.title` | 空标题使用“无标题”，不使用模型补写 |
| 作者 | `creators_json` | 1–3 位，更多显示“等”；保留完整详情 |
| 日期 | `date_text` | 原样显示并标注来源，不强行解析为年份 |
| 标签 | `tags_json` | Zotero 标签 |
| 分析状态 | analysis/fulltext/retry 字段 | 显式区分待分析、仅摘要、全文、头尾采样、重试等待 |
| 全部/待处理/已整理数量 | 同一次查询的真实 count | 与筛选结果一致 |
| 排序 | `firstSeenAt` 或 title | 默认最近添加；规则由 API 执行 |

### 5.2 详情

显示题录、研究方向、主要成果、明确不足、分析依据、是否截断、错误摘要和下次重试时间。分析不存在时不显示空洞模板文本。

动作：

- “在 Zotero 中打开”：使用后端返回的白名单链接。
- “在 Obsidian 中打开”：仅卡片存在时启用。
- “同步 Zotero”“立即整理”：创建 operation 并展示真实阶段。

### 5.3 主题统计

- S2 可以显示近 7 天 Zotero 标签频次、新增数、分析完成数。
- “你最近更关注……”等推断性画像延期，除非定义、保存并展示计算依据。
- “生成主题索引”退出首版；当前没有对应领域合同。

## 6. 任务页（S2）

正式客户端优先采用紧凑分组列表，不照搬 demo 看板。

| 列/分组 | 状态映射 |
| --- | --- |
| 待安排 | `draft`、`needs_replan`；后者置顶并显示冲突原因 |
| 已计划/进行中 | `planned`、`in_progress` |
| 已完成 | `completed`，默认最近项 |
| 已取消 | 默认隐藏，通过筛选查看 |

每项必须显示：

- title、taskKind、sourceType；
- deadline、estimatedMinutes、priority；
- status；
- plannedStart/End 和 Calendar 同步状态（存在时）。

来源规则：

- `manual` 显示“手动录入”。
- `email` 显示最少来源信息和 Gmail message ID；不复制整封邮件。

动作合同：

- 新建/编辑本地字段；
- start、complete、cancel；
- 查看候选时段；
- 选择时段后只生成 pending approval；
- 不通过拖拽直接修改 Google Calendar。

demo 中“本周完成 14/18”“预计投入 11.5h”“65%”在未定义查询前退出。等待确认数量可由 pending workflow actions 真实计算。

## 7. 日历页（S2）

| 样式 | 来源 | 语义 |
| --- | --- | --- |
| 蓝色 | Google Calendar | 真实外部事件 |
| 紫色 | 本地讲座/组会 | `lectures` |
| 绿色 | 已计划任务 | `research_tasks`；与 Calendar 事件去重 |
| 橙色虚线 | pending workflow action | 尚未写入外部日历 |
| 红色边框 | 服务端确认的冲突 | 不能仅按像素重叠推断 |

接口范围必须显式传 `start/end`。选中事件在右侧显示来源、时间、状态和打开入口。首版不允许拖拽修改 Google 事件。

Calendar 不可用时仍显示本地讲座、任务和待审批项，并标记 partial。

## 8. 设置页（S2）

### 8.1 连接卡

| 连接 | 可见字段 | 探测规则 |
| --- | --- | --- |
| Zotero | local API 状态、libraryVersion、lastSyncAt | 实际健康探测；历史成功不等于当前在线 |
| Obsidian | Vault 路径、存在、可写、打开 | 实际文件系统检查；未安装 Obsidian 时 Markdown 仍可写 |
| Google Calendar | connected/expired/missing、最少账号信息 | 检查 OAuth 和必要 scope；不返回 token |
| Gmail | connected/expired/missing、只读标识 | 检查 `gmail.readonly` |
| DeepSeek | configured/missing | 只返回是否配置，不返回 key |

### 8.2 自动化

显示：enabled、time、lastRun、lastResult、nextRun。保存必须：

1. 验证 `HH:mm` 与时区；
2. 持久化配置；
3. 更新对应 job；
4. 返回重新计算后的 nextRun；
5. 失败时回滚界面开关。

当前配置还没有 enabled 字段；实现设置页前必须完成数据模型中标出的扩展。

## 9. 快速记录（S2）

三种表单不能共用 demo 的“标题 + 说明 + 标签 + 日期”泛化模型。

| 类型 | 必填 | 可选 | 写入结果 |
| --- | --- | --- | --- |
| Idea | body | title、tags | Obsidian `Ideas/`，返回真实 note 元数据 |
| 任务 | title、taskKind、estimatedMinutes | deadline、priority | SQLite `research_tasks`，状态 `draft` |
| 讲座 | title、startAt | endAt、location、speaker、notes、requiresPresentation | SQLite `lectures` + 提醒 jobs |

成功后刷新相关页面；Idea 不自动变成任务，任务不自动写入 Calendar。

## 10. 搜索与 Agent（S3）

### 10.1 搜索

搜索范围：论文、任务、Idea、讲座。结果必须包含 `type`、`source`、`title`、匹配摘要和打开目标。

- 库内搜索结果是事实数据。
- Agent 回答单独分区并标注模型生成。
- 首版先聚合现有来源；未验证性能前不引入向量库。

### 10.2 Agent 会话

- 使用现有工具和审批门控；模型不能自行 approve。
- `Ctrl+K` 面板是同一条对话的唯一入口，不新增 Agent 一级页面。
- 消息轨迹按“你 / Agent / 工具结果”分区展示；回答属于模型生成，不能与库内搜索事实混排。
- 轨迹来自 `/api/conversations`，客户端不保存私有副本；打开面板时恢复最近一次 active 对话并滚动到最新消息。
- “新对话”只清空当前线程，下一次提问才创建会话；“删除对话”必须二次确认，删除后本地 API 返回 404。
- 失败状态保留在面板内（如 `Agent 暂时不可用`、`无法读取上次对话`），不通过 toast 报告。
- 外部文本作为不可信数据，不能改变系统规则。
- 引用目前固定为空数组；界面不得展示模型自行编造的引用。
- 尚无历史裁剪、摘要与长期记忆，界面文案不得暗示具备这些能力。

## 11. 字段退出清单

下列 demo 字段不得进入正式客户端，除非先补充新的数据合同：

- 硬编码姓名、头像、日期、城市和连接状态；
- “本周 +12%”等无定义趋势；
- 任务百分比进度；
- “你最近更关注……”推断画像；
- 气泡/轨道主题图及其模拟数字；
- 模拟同步成功、模拟深读成功和 `setTimeout` 状态；
- 只存在于浏览器内存中的完成、审批或设置结果；
- 通过 toast 承载且刷新后丢失的关键错误。

## 12. 后续方向与完成标准

### 阶段 1 完成标准

- `/api/health`、`/api/today` 使用真实数据。
- 今日重点、时间线、知识摘要、审批只读卡均能追溯到对象 ID。
- 天气或 Calendar 失败时页面进入 partial，本地数据仍显示。
- 长标题、空数据、离线、100%–200% DPI 可用。

### 阶段 2 完成标准

- 知识库、任务、日历、设置和快速记录使用本文字段合同。
- 本地写入重启后仍存在。
- 同步/整理有真实 operation 状态，不模拟进度。
- 设置修改确实更新 worker 调度。

### 阶段 3 完成标准

- Calendar 写入无法绕过审批。
- 搜索结果与 Agent 回答清晰分区。
- 审批、任务、论文可通过稳定 ID 深链打开。

### 阶段 6 完成标准（v0.4.0）

- 面板显示真实消息轨迹，不出现空回答或上一轮回答冒充本轮。
- 连续两轮提问使用同一 conversation ID；关闭客户端和本地服务后重开仍可继续。
- 新对话、删除对话的行为与本地 API 状态一致；删除后轨迹不可再读取。

### 发布切换标准

- 本表中所有“退出”字段已从生产 UI 删除。
- README 不再要求普通用户使用 CLI 完成日常流程。
- WinForms 表单、`launcher/` 和 `demo/` 已在 v0.3.0 删除，正式 UI 只保留 WPF 客户端。
