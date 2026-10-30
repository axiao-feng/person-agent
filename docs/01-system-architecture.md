# Person Agent 系统架构

> 文档状态：阶段 0 基线
>
> 适用范围：Windows 原生客户端迁移
>
> 对应产品基线：`PRODUCT_DESIGN.md`
>
> 最后更新：2026-10-30
>
> 实现状态（2026-10-30）：阶段 1–3 的本地 API 与 WPF 五页客户端已实现；阶段 4/5（旧入口删除与完整可用性验收）尚未完成。

## 1. 文档目的

本文冻结 Person Agent 的进程边界、数据边界和依赖方向，使 WPF 客户端可以在不重写现有 TypeScript 业务规则的前提下开工。

本文中的状态标记：

- **现有**：仓库中已有实现，可复用。
- **阶段 1**：WPF“今日”页原型开工前必须实现。
- **阶段 2/3**：后续页面或 Agent/审批阶段实现。
- **不做**：首版明确排除。

## 2. 架构结论

Person Agent 采用“WPF 表现层 + 本机 TypeScript 应用服务 + 独立 worker”的三进程形态：

```text
┌──────────────────────── Windows 当前用户会话 ────────────────────────┐
│                                                                    │
│  PersonAgent.Desktop.exe（WPF）                                    │
│    Views / ViewModels / 原生对话框                                 │
│                 │ typed HTTP + session token                       │
│                 ▼                                                  │
│  person-agent serve（Node.js，本次 UI 会话的子进程）                │
│    路由 / DTO / 聚合查询 / 错误映射                                │
│                 │                                                  │
│                 ▼                                                  │
│  现有 TypeScript 领域方法                                          │
│    AppDatabase / schedule / knowledge / integrations / agent       │
│         │             │             │             │                │
│         ▼             ▼             ▼             ▼                │
│      SQLite       Obsidian       Zotero API     Google/Open-Meteo  │
│                                                                    │
│  person-agent worker run（Windows 计划任务，独立生命周期）          │
│                 └──────── 调用同一批 TypeScript 领域方法 ──────────┘│
└────────────────────────────────────────────────────────────────────┘
```

核心约束：

1. WPF 只负责表现和客户端状态，不直接访问 SQLite、Markdown、OAuth token 或第三方 API。
2. HTTP 层只负责鉴权、输入输出转换、聚合和错误映射，不复制领域规则。
3. worker 与 HTTP 服务调用相同的领域方法；不得出现“UI 版校验”和“worker 版校验”。
4. Gmail、Zotero 保持只读；Calendar 写入只能执行已持久化且 payload 未变化的审批。
5. 任一外部来源失败时，SQLite 和 Obsidian 的本地能力继续可用。

## 3. 当前实现与目标形态

| 能力 | 当前状态 | 目标状态 |
| --- | --- | --- |
| 领域逻辑 | **现有**：`src/` 中的 TypeScript 方法 | 继续复用，必要时拆出薄 service 函数 |
| SQLite | **现有**：Node 内置 SQLite，WAL + 5 秒 busy timeout | API 与 worker 共享同一数据库文件 |
| 后台任务 | **现有**：Windows 计划任务运行 worker | 保持独立，不随 UI 关闭而停止 |
| 桌面 UI | **现有**：WinForms 快速录入；静态 demo；**阶段 1–3 已新增** WPF 五页客户端 | 阶段 4/5 验收后删除旧入口 |
| 本地 HTTP | **现有（阶段 1–3）**：`src/server/` 与 `person-agent serve`；已实现 OpenAPI 合同中的全部接口 | 后续只做兼容性修正与测试补强 |
| 其余页面 API | **现有（阶段 2）**：任务、论文、日历、设置、快速记录、讲座与 Idea 接口 | 后续只做兼容性修正与测试补强 |
| 审批与 Agent UI | **现有（阶段 3）**：审批卡/确认弹窗、Ctrl+K 搜索与 Agent、批准与拒绝 | 阶段 4/5 补通知深链与验收 |
| Web demo | 静态模拟数据 | 等价能力验收后删除，不进入生产架构 |

不能把目标接口或 WPF 客户端描述成“已经实现”。

## 4. 组件职责

### 4.1 WPF 客户端

WPF 负责：

- 主窗口、五个入口、右侧上下文面板、原生对话框和键盘交互。
- 调用 `docs/api/openapi.yaml` 定义的本地接口。
- 维护请求中的 `loading / refreshing / success / empty / partial / error` 表现状态。
- 在刷新失败时保留上一次成功数据，并显示数据时间。
- 将用户操作转换成明确命令，例如 `start`、`complete`、`approve`，而不是直接写领域状态。
- 通过 Windows Shell 打开后端返回且经过白名单验证的 Obsidian/Zotero 深链接。

WPF 不负责：

- 计算空闲时段、任务优先级或重试时间。
- 读写数据库、Vault 文件或凭据。
- 生成 Calendar payload 或改变待审批 payload。
- 调用 DeepSeek、Google、Zotero 或 Open-Meteo。

建议项目边界：

```text
client/PersonAgent.Desktop/
  Views/             # XAML 与最少 code-behind
  ViewModels/        # 页面状态、命令、导航
  Services/          # OpenAPI 客户端、进程启动、Shell 打开
  Models/            # 由 OpenAPI 生成或严格对应的 DTO
```

### 4.2 本地 HTTP 应用服务

本地服务负责：

- 仅监听 `127.0.0.1` 的随机可用端口。
- 校验本次 UI 会话 token、`Content-Type`、请求大小和 DTO。
- 组装“今日”这类跨来源 view model。
- 将领域错误映射为稳定错误码，不向 UI 暴露堆栈、token 或第三方原始响应。
- 给每个响应附带 `requestId` 和 `generatedAt`。
- 对并行外部读取使用独立超时；返回 `partial` 而不是让整页失败。

本地服务不得成为第二套领域层。路由处理器不应直接写 SQL，也不应复制 `AppDatabase` 中的校验。

### 4.3 领域层

现有领域能力包括：

- `AppDatabase`：讲座、提醒、科研任务、审批、Zotero 状态、定时任务与运行记录。
- `schedule.ts`：时区、周期计算和空闲时段。
- `knowledge/`：Zotero 同步、论文分析、Vault 写入、日报生成和打开笔记。
- `integrations/`：Google 与天气。
- `agent.ts`、`tools.ts`：模型调用和工具门控。
- `worker.ts`：定时任务、补发、通知和计划冲突检查。

新增 HTTP 功能时，优先把可复用的领域操作提取为普通函数，再让 CLI、HTTP、worker 共同调用；不要让 HTTP 调 CLI 子进程。

### 4.4 worker

worker 是独立的长期后台进程：

- 每 30 秒处理到期任务。
- 每 15 分钟检查已计划任务的 Calendar 变化。
- 维护 07:30 晨间简报和 22:30 知识整理。
- 负责补发、退避、冲突检测和 Windows 通知。

UI 退出不能停止 worker。UI 可以显示 worker 状态，但不能把“Windows 计划任务已安装”等同于“当前正在运行”；无法确认时必须显示 `unknown`。

## 5. 进程生命周期

### 5.1 客户端启动（阶段 1）

1. WPF 使用单实例锁；第二次启动把激活参数交给已有窗口。
2. WPF 生成一次性的 256 位随机 session token。
3. WPF 以隐藏子进程启动 `person-agent serve --port 0`，token 通过子进程环境传递，不出现在命令行和日志。
4. 服务在 stdout 输出一行机器可读的就绪消息，只含端口和协议版本，不含 token。
5. WPF 调用 `/api/health`；协议版本不兼容时停止加载并给出修复提示。
6. WPF 并行加载 `/api/today` 和连接状态。

启动超时建议为 10 秒。失败时保留“重试启动”和“打开诊断”入口，不静默回落到 demo。

### 5.2 客户端退出

- WPF 关闭为服务保留的控制 stdin；服务在 EOF 后优雅退出，超时后只终止该子进程。
- 不停止或卸载 Windows 计划任务中的 worker。
- 不清理 SQLite、Vault、配置或日志。

### 5.3 崩溃恢复

- HTTP 服务不保存仅存在于内存中的领域状态。
- 本地写操作先持久化，再返回成功。
- Calendar 写入使用已有审批记录和稳定事件 ID，重试不得创建重复事件。
- WPF 重启后从 API 重新读取任务、审批、论文和操作状态。

## 6. 通信与安全边界

阶段 1 最小要求：

- 只监听 IPv4 loopback；不监听 `0.0.0.0`、局域网地址或公网地址。
- 所有 `/api/*` 请求要求 `X-Person-Agent-Token`。
- 只接受桌面客户端发出的请求；拒绝浏览器跨站 Origin。
- 写请求只接受 `application/json`，并限制请求体大小。
- token、OAuth 数据、邮件正文和论文全文不得写入普通日志。
- 错误响应使用稳定错误码；详细堆栈仅进入脱敏后的本地诊断日志。

首版不建设远程访问、账号系统、局域网共享或浏览器 UI。

## 7. 数据与并发

### 7.1 真相来源

| 数据 | 真相来源 | 权限 |
| --- | --- | --- |
| 任务、讲座、提醒、审批、论文处理状态 | SQLite | 读写 |
| Idea、论文卡片、日报 | Obsidian Markdown | 仅更新程序管理区块 |
| 文献题录与全文 | Zotero 本地 API | 只读 |
| 邮件 | Gmail | 只读 |
| 外部日程 | Google Calendar | 读；审批后写 |
| 配置 | `%LOCALAPPDATA%\person-agent\config.json` | 读写 |
| 凭据 | DPAPI 加密文件或用户环境变量 | 受控读取 |

### 7.2 SQLite 并发

API 与 worker 可以是两个进程。继续使用 WAL、外键和 busy timeout；每次写入保持短事务。长时间的网络或模型调用不得包在数据库事务中。

阶段 2 的手动同步/整理必须具有持久化操作 ID，避免 UI 与 worker 同时启动重复任务。具体模型见 `docs/03-domain-data-model.md`。

### 7.3 时间规则

- 持久化时间统一使用带 `Z` 的 ISO 8601 UTC 字符串。
- 日期边界、工作日和展示时间使用配置的 IANA 时区，默认 `Asia/Shanghai`。
- API 的纯日期参数使用 `YYYY-MM-DD`，含时间参数使用 RFC 3339。
- UI 不根据本机当前时区擅自重算业务日期。

## 8. “今日”聚合边界（阶段 1）

`GET /api/today` 是阶段 1 唯一的跨来源聚合接口。服务端负责：

- 读取本地任务、讲座、自动任务和待审批操作。
- 尝试读取 Calendar 与天气；失败时记录单来源状态。
- 合并并排序时间线。
- 按固定、可解释规则选择最多三项 `focusItems`。
- 返回最近知识处理状态，但不在请求中自动触发深读。
- 去重已与 Calendar 事件关联的计划任务。

UI 不重新计算重点顺序、冲突或“可用专注时间”。没有可靠计算规则的 demo 统计直接退出。

## 9. 可观测性

最小日志字段：

- `timestamp`
- `level`
- `event`
- `requestId`（HTTP 请求）
- `operationId` / `jobId`（适用时）
- 脱敏后的错误类别
- duration

不得记录：API key、OAuth token、session token、完整邮件正文、论文全文、审批 payload 中的敏感正文。

`/api/health` 的成功仅表示本地服务可响应；第三方连接失败应形成 `degraded`，而不是把整个服务判定为不可用。

## 10. 关键架构决定

| 决定 | 结论 | 原因 |
| --- | --- | --- |
| 正式 UI | WPF + .NET 8 | 满足 Windows 原生交互、高 DPI 和可访问性要求 |
| 前后端通信 | typed loopback HTTP | 复用 TypeScript 领域逻辑，避免 C# 重写 |
| WebView2/Electron/Tauri | 不采用 | 不保留第二套网页产品形态 |
| 数据库 | 继续使用现有 SQLite | 单用户本地场景足够；保留迁移兼容 |
| 长任务 | 服务端持久化、UI 轮询 | UI 关闭/刷新不应丢失真实状态 |
| Calendar 写入 | 固定 payload 审批 | 保持用户确认和可追溯性 |
| 搜索 | 首版聚合现有来源 | 数据量证明需要前不引入搜索服务或向量库 |

## 11. 后续方向

### 阶段 1：今日页原型

- 新增 `src/server/` 和 `person-agent serve`。
- 实现 `/api/health`、`/api/today`。
- 新建 WPF 壳、导航、今日页和右侧审批详情只读视图。
- 完成真实数据、空数据、局部失败和高 DPI 验证。

### 阶段 2：其余页面与本地写入

- 实现任务、讲座、Idea、论文、日历和设置接口。
- 增加持久化 `operations`，用于同步/整理进度与互斥。
- 接入快速记录和 Obsidian/Zotero 打开动作。

### 阶段 3：审批、搜索与 Agent

- 将 CLI `/approve` 收敛为审批卡和确认对话框。
- 实现跨来源搜索；规模不足以证明必要前不增加 FTS/向量库。
- 接入 Agent 抽屉，明确区分库内搜索结果与模型回答。

### 阶段 4/5：切换与验收

- Windows 通知深链到新客户端对象。
- 等价能力验收后删除 WinForms 业务表单和 `demo/`。
- 补齐发布、升级、回滚、离线、高 DPI 和关键端到端测试。

## 12. 暂不决定的事项

以下问题不阻塞阶段 1，留到对应阶段冻结：

- 安装包采用 MSIX 还是传统安装器。
- Agent 消息是否需要流式传输；首版合同按非流式响应。
- 搜索是否需要 SQLite FTS；先用真实数据测量。
- 长任务进度是轮询还是本地事件流；首版按轮询。
