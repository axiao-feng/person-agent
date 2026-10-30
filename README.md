# Person Agent

一个面向研究生的本地任务型 Agent：从 Gmail 识别待办，结合 Google Calendar 计算空闲时段，在本地审批后写入日历；持续监控冲突并提出重排方案，同时提供讲座、提醒和每日简报。每晚还会把 Zotero 新增论文、idea、作业/科研任务和录入讲座整理进本地 Obsidian 知识库。

## 技术栈

- TypeScript + Node.js 22.19 或更高版本
- `@earendil-works/pi-agent-core` 0.86.0
- DeepSeek V4.1 Flash（`deepseek/deepseek-flash`，默认 `low` 思考级别）
- Google OAuth：Gmail 只读、Calendar 事件读写
- Open-Meteo 天气
- Zotero 7 本地 API（只读）
- 标准 Markdown Obsidian vault
- .NET Framework 自带 C# 编译器构建的轻量 WinForms 启动器
- Node 内置 SQLite、测试运行器和 `fetch`

## 安装

```powershell
pnpm install
pnpm build
pnpm link --global
person-agent setup
```

也可以不做全局链接，开发时使用：

```powershell
pnpm dev -- setup
pnpm dev -- chat
```

如果当前 PowerShell 找不到 `node`，可直接使用仓库内的 Windows 启动器：

```powershell
.\person-agent.cmd chat
```

`setup` 还可以修改知识库目录和晚间整理时间。默认值是：

- 知识库：`C:\Users\<用户名>\Documents\Person Agent Knowledge`
- 晚间知识整理：`22:30`

安装桌面录入程序（编译 `launcher/bin/PersonAgent.exe` 并创建桌面、开始菜单快捷方式）：

```powershell
pnpm build
person-agent launcher install
```

仓库移动后需要重新运行 `launcher install`，因为启动器保存了当前仓库的 CLI 路径。

### Google OAuth 准备

1. 在 Google Cloud Console 创建项目。
2. 启用 Gmail API 和 Google Calendar API。
3. 配置 OAuth consent screen，把自己的 Google 账号加入测试用户。
4. 创建 Desktop app OAuth client，下载客户端 JSON。
5. 运行 `person-agent setup`，输入 JSON 路径并在浏览器授权。

应用只申请：

- `gmail.readonly`
- `calendar.events`
- `calendar.calendarlist.readonly`

旧版本只授予过 `calendar.readonly` 时，需要重新运行 `person-agent setup` 以取得 Calendar 事件写权限。

OAuth token 和可选的 DeepSeek key 使用当前 Windows 用户的 DPAPI 加密保存在 `%LOCALAPPDATA%\person-agent`。也可以不存 DeepSeek key，改用用户环境变量：

```powershell
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "你的-key", "User")
```

## 使用

日常主入口是上面的 Windows 原生客户端；CLI 继续保留 `setup`、`doctor`、`worker` 和故障恢复能力，也保留给高级用户。以下命令仍可独立使用。

```powershell
# 交互式聊天
person-agent chat

# 诊断本地配置（不会输出密钥）
person-agent doctor

# 结构化录入讲座；也可以在 chat 中用自然语言录入
person-agent lecture add `
  --title "可信人工智能讲座" `
  --start "2026-09-23T19:00:00+08:00" `
  --location "学术报告厅"

# 明确需要汇报时增加提前 72 小时提醒
person-agent lecture add `
  --title "课题组组会" `
  --start "2026-09-25T15:00:00+08:00" `
  --requires-presentation

person-agent lecture list
person-agent lecture update --id <ID> --location "新报告厅"
person-agent lecture cancel --id <ID>

# 通用提醒
person-agent reminder add --title "交实验报告" --at "2026-09-25T18:00:00+08:00"
person-agent reminder add --title "晨读" --daily "08:00"
person-agent reminder add --title "组会" --weekly "1,4" --time "14:00"
person-agent reminder list
person-agent reminder cancel --id <ID>

# 知识库录入与整理
person-agent idea add --title "评估方法" --body "用对照实验验证检索质量。" --tags 实验,方法
person-agent task add --kind assignment --title "数值分析作业" --deadline "2026-11-01T18:00:00+08:00" --minutes 90
person-agent knowledge sync
person-agent knowledge digest
person-agent knowledge open-today
```

新讲座或组会会自动创建提前 24 小时提醒；明确需要汇报时，再增加提前 72 小时提醒。`task add` 只写本地任务表，不会创建 Calendar 事件；Calendar 写入仍必须走审批（客户端待审批卡，或 CLI 高级用户的 `/approve`）。

## 知识库与晚间整理

默认生成三个固定目录：

```text
Person Agent Knowledge/
  Ideas/                 # 主动记录的 idea
  Papers/<zoteroKey>.md  # 稳定、无重名的论文卡片
  Daily/YYYY-MM-DD.md    # 当日知识简报
```

- 论文卡片使用 Obsidian properties 和双链，并通过 `person-agent` 标记区分程序生成区块。程序只更新标记内内容，标记外的手写批注和自定义 properties 会保留。
- `knowledge sync` 只读调用 Zotero 本地 API `/api/users/0/items/top`，增量保存库版本、条目版本和处理状态；不会修改 Zotero、扫描下载目录或联网补论文。
- 新论文先建立题录卡片。`knowledge digest` 每晚最多深读 5 篇：优先读取 Zotero 已索引全文，生成“研究方向、主要成果、明确不足、分析依据”。全文过长时使用开头 40000 字和结尾 20000 字的头尾采样，并明确标记“正文已截断”；没有全文时只依据摘要生成前两部分，并明确标注证据不足；之后发现全文会自动补全。
- 分析失败按 1 小时、6 小时、24 小时、72 小时逐级退避；每日额度优先给新论文，同时保留一个重试槽位，持续失败的论文不会堵住后续新论文。
- 论文全文和摘要始终作为不可信数据。深读使用无工具的独立模型调用，文本不能改变系统指令或触发工具。
- 晚间简报汇总当天新增论文、idea、作业/科研任务和录入讲座，只做整理与链接，不会从 idea 自动派生任务。
- 同一天重复执行只更新生成区块，不产生重复笔记。同步游标只在论文卡片成功写入后推进，失败条目保留在队列重试。所有 Markdown 写入先写同目录临时文件再原子替换，写入中断不会损坏块外的手写批注。
- DeepSeek 不可用时仍写入确定性的列表版简报。完成后通过 `obsidian://open` 打开当日笔记；未安装 Obsidian 时用系统默认 Markdown 程序打开。

`22:30` 任务复用现有 `briefing` 定时任务类型和独立任务 ID，不会重建 jobs 表。worker 会扫描最近 7 天内尚未完成的日期，按从旧到新的顺序逐日补发；即使次日 11:00 才开机也不会丢掉前一晚的整理。失败任务按 1 小时、6 小时、24 小时退避后重新入队并真正重跑，连续 4 次失败后停止自动重试。覆盖 `briefing` 的既有晨间流程不受影响。

## 桌面录入程序

> 迁移期旧入口：日常记录请使用上面的 Windows 原生客户端；阶段 4 等价能力验收后删除本程序。

`launcher install` 使用 Windows 自带 .NET Framework C# 编译器生成 `launcher/bin/PersonAgent.exe`，不引入 Electron。程序提供 Idea、作业、讲座三个页面：

- Idea：正文必填，标题可空并从首行生成，标签可选。
- 作业：标题必填，截止时间可选，默认 60 分钟、中优先级。
- 讲座：复用现有讲座字段和校验。
- 公共按钮：保存、保存并关闭、立即整理、打开今日日报。保存成功后当前页输入会清空，避免同一条记录被再次提交。

EXE 隐藏调用与命令行完全相同的 CLI，校验和写入逻辑只有一份。所有操作只写本地知识库或 SQLite，不会自动写 Calendar。

## Windows 原生客户端

阶段 1–3 的本地应用服务和 WPF 五页客户端已可用。客户端启动时会生成一次性会话 token，通过 `PERSON_AGENT_SESSION_TOKEN` 环境变量传给隐藏的 `person-agent serve` 子进程；服务只监听 `127.0.0.1`，浏览器来源请求会被拒绝。

当前可用：

- 今日：真实今日重点、时间线、知识流和审批卡；任务开始/完成、审批批准/拒绝。
- 知识库：论文列表与筛选、分析详情、Zotero/Obsidian 打开入口、手动同步与知识整理（持久化 operation 状态）。
- 任务：待安排/已计划/最近完成分组、编辑、开始、完成、取消、候选空闲时段和生成 Calendar 待审批操作。
- 日历：一周七列视图，聚合 Google 日程、本地讲座、已计划任务和待审批时段。
- 设置：真实连接状态、自动化开关与时间、知识库路径和时区；保存后同时更新配置和 worker 调度。
- 快速记录：Idea / 任务 / 讲座三种独立表单。
- Ctrl+K：库内搜索与 Agent 回答分区展示；搜索结果可跳转到任务或论文详情。
- 所有写操作通过本地接口完成；Calendar 写入无法绕过审批卡。

本地接口覆盖 `docs/api/openapi.yaml` 中的健康、今日、任务、候选时段、排期、日历、讲座、Idea、论文、知识同步/整理、operation、审批、设置、搜索和 Agent。

构建与运行：

```powershell
pnpm build
dotnet build client/PersonAgent.Desktop/PersonAgent.Desktop.csproj -c Debug
dotnet run --project client/PersonAgent.Desktop/PersonAgent.Desktop.csproj
```

构建需要 .NET 8 SDK，运行需要 .NET 8 Desktop Runtime。客户端默认从仓库的 `dist/src/cli.js` 拉起服务；也可以通过 `PERSON_AGENT_CLI` 指定 CLI 路径，用 `PERSON_AGENT_NODE` 指定 node 可执行文件。`PERSON_AGENT_SERVE_COMMAND` 可指定服务可执行文件（客户端仍会追加 `serve --port 0`）。

## 科研任务闭环

在 `person-agent chat` 中可以直接输入：

```text
检查导师最近一周的邮件，把明确要求我完成的事项保存为任务；
结合本周日历安排到空闲时间，不要占用组会，写入日历前让我确认。
```

Agent 会按以下过程工作：

1. 搜索并读取候选邮件，保存 Gmail message ID 作为任务来源。
2. 对不明确的任务或截止时间先追问。
3. 用确定性算法合并 Calendar、讲座和本地计划，计算工作时段。
4. 将任务保存为可逆的 `draft`，展示计划后生成 Calendar 待审批操作。
5. 用户在客户端“今日 → 待审批”中核对固定 payload 并确认后才执行写入；拒绝则放弃。CLI 高级用户仍可用 `/approve <ID>`、`/reject <ID>` 和 `/pending` 完成同样操作。
6. 后台发现关联事件被删除或新增日程冲突时，将任务标记为 `needs_replan`，计算候选时段并通过 Windows 通知给出新的审批 ID。

审批内容、执行状态和结果持久化在 SQLite。模型不能自行批准操作；执行参数与审批快照不一致时，业务层会拒绝执行。Calendar 创建使用稳定事件 ID，异常退出后的重试不会重复创建事件。

## 后台提醒

先完成 `setup` 和 `build`，再安装当前用户的登录自启动任务：

```powershell
# 安装后立即启动，并注册登录自启动
person-agent worker install

# 手动启动已安装的任务
person-agent worker start
person-agent worker status

# 调试时前台运行
person-agent worker run

# 移除自启动任务
person-agent worker uninstall
```

worker 每 30 秒检查一次到期任务，每 15 分钟检查一次已计划科研任务的日历变化。每天 07:30（可在 `setup` 中修改）由业务代码并行读取天气、日程和讲座，再让模型根据固定数据快照生成简报；固定取数流程不交给 Agent 自主规划。每天 22:30（同样可在 `setup` 中修改）执行晚间知识整理，同步 Zotero、深读论文并写当日日报。

## 开发与验证

```powershell
pnpm run typecheck
pnpm test
pnpm build
```

当前 75 项自动化测试覆盖时区调度、任务幂等、通知重试、崩溃恢复、邮件解析、空闲时段、任务持久化、任务状态机、Calendar 审批门控与执行、候选时段、冲突检测和重排提案、配置兼容与自动化开关、数据库增量迁移、Obsidian 区块幂等与批注保留、Zotero 分页/版本游标/去重/全文头尾采样与降级/每日 5 篇限流、模型与全文请求的失败退避及新论文优先、失败任务延迟后真正重跑、跨 12 小时的隔夜补发与多日补发队列、CLI 录入路径和 Obsidian 打开回退，以及本地 API 的会话 token 鉴权、跨站拒绝、今日/任务/日历/论文/设置/搜索/Agent 接口、知识 operation 互斥、空数据、局部失败降级、`serve` 启停和 worker 运行状态映射。

另有 20 条真实模型场景评测。它使用本地工具夹具，不访问真实 Gmail 或 Calendar，但会实际调用已配置的 DeepSeek，验证工具路由、澄清、提示注入防护和写操作审批：

```powershell
pnpm run eval:agent
```

评测逐条输出 JSON，任一场景不满足预期工具、禁用工具或回答约束时以非零状态退出。该命令会消耗模型额度，因此不包含在普通 `pnpm test` 中。

新增 Agent 工具时实现一个 `ToolModule` 并传给 `createAssistant`：

```ts
import type { ToolModule } from "./src/index.js";

const tools: ToolModule = (context) => [/* AgentTool */];
```

v1 没有 Web UI、邮件发送、任意 cron、长期语义记忆或多用户支持。邮件发送保持禁用；Calendar 写入只允许通过本地审批门控执行。知识库只使用 Zotero 本地 API 和已索引全文，不联网搜索论文、不扫描下载目录、不常驻托盘，运行时也只使用 DeepSeek Flash。

## 第三方参考

Google OAuth、Gmail MIME 和 Calendar 归一化设计参考了 MIT 项目 DailyOS。详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
