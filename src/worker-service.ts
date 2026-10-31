import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const TASK_NAME = "Person Agent";

export type WorkerTaskCommands = {
  schtasks(args: string[]): string;
  powershell(script: string): string;
};

export type WorkerRuntimeState = "running" | "stopped" | "not_installed" | "unknown";

export type WorkerRuntimeHealth = {
  state: WorkerRuntimeState;
  lastRunAt: string | null;
};

const defaultCommands: WorkerTaskCommands = {
  schtasks: runSchtasks,
  powershell: runPowerShell,
};

export function installWorkerTask(
  commands: WorkerTaskCommands = defaultCommands,
  cliPath = builtCliPath(),
): string {
  requireWindows();
  if (!existsSync(cliPath)) throw new Error("找不到 dist/cli.js，请先运行 pnpm build。");
  const command = `"${workerNodePath()}" "${cliPath}" worker run`;
  commands.schtasks(["/Create", "/F", "/SC", "ONLOGON", "/TN", TASK_NAME, "/TR", command, "/RL", "LIMITED"]);
  commands.powershell(`
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$logon = New-ScheduledTaskTrigger -AtLogOn
$logon.Delay = 'PT2M'
$repeat = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 5)
Set-ScheduledTask -TaskName '${TASK_NAME}' -Trigger @($logon, $repeat) -Settings $settings | Out-Null
`);
  startWorkerTask(commands, cliPath);
  return `已安装并启动登录自启动任务：${TASK_NAME}`;
}

export function startWorkerTask(
  commands: WorkerTaskCommands = defaultCommands,
  cliPath = builtCliPath(),
): string {
  requireWindows();
  if (!existsSync(cliPath)) throw new Error("找不到 dist/cli.js，请先运行 pnpm build。");
  const state = commands.powershell(`
Start-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction Stop
$deadline = (Get-Date).AddSeconds(5)
$state = 'Unknown'
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 300
  $state = (Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction Stop).State
  if ($state -eq 'Running') { break }
}
$state
`).trim();
  if (state !== "Running") {
    throw new Error(`任务已触发但未保持运行，当前状态：${state || "未知"}。`);
  }
  return `已启动任务：${TASK_NAME}`;
}

export function workerTaskStatus(commands: WorkerTaskCommands = defaultCommands): string {
  requireWindows();
  let info: ScheduledTaskInfo;
  try {
    info = readTaskInfo(commands);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return `任务：${TASK_NAME}\n状态：无法读取（${message}）`;
  }
  if (!info.installed) return `任务：${TASK_NAME}\n状态：未安装`;
  const running = info.state === "Running" || info.state === "Queued";
  const lines = [
    `任务：${TASK_NAME}`,
    `状态：${running ? "运行中" : "已停止"}（${info.state ?? "Unknown"}）`,
  ];
  // A 5-minute trigger refused by IgnoreNew updates LastTaskResult even though
  // the existing worker is healthy, so only show history while stopped.
  if (!running) {
    if (info.lastRunAt) lines.push(`上次运行：${formatTaskTime(info.lastRunAt)}`);
    if (info.lastResult !== null) lines.push(`上次结果：${formatTaskResult(info.lastResult)}`);
  }
  if (info.nextRunAt) lines.push(`下次运行：${formatTaskTime(info.nextRunAt)}`);
  return lines.join("\n");
}

/**
 * Report whether the Windows worker task is currently running. "Ready" only
 * means the task is installed and waiting, never that the worker process is
 * alive, so it maps to "stopped".
 */
export function workerTaskHealth(commands: WorkerTaskCommands = defaultCommands): WorkerRuntimeHealth {
  if (process.platform !== "win32") return { state: "unknown", lastRunAt: null };
  try {
    const info = readTaskInfo(commands);
    if (!info.installed) return { state: "not_installed", lastRunAt: null };
    if (info.state === null) return { state: "unknown", lastRunAt: null };
    const state: WorkerRuntimeState =
      info.state === "Running" || info.state === "Queued"
        ? "running"
        : info.state === "Unknown"
          ? "unknown"
          : "stopped";
    return { state, lastRunAt: info.lastRunAt };
  } catch {
    return { state: "unknown", lastRunAt: null };
  }
}

export function uninstallWorkerTask(commands: WorkerTaskCommands = defaultCommands): string {
  requireWindows();
  commands.schtasks(["/Delete", "/F", "/TN", TASK_NAME]);
  return `已删除登录自启动任务：${TASK_NAME}`;
}

function builtCliPath(): string {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const compiled = join(sourceDirectory, "cli.js");
  if (existsSync(compiled)) return compiled;
  let directory = sourceDirectory;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(directory, "package.json"))) {
      return join(directory, "dist", "src", "cli.js");
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return compiled;
}

function workerNodePath(): string {
  const systemNode = join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe");
  return existsSync(systemNode) ? systemNode : process.execPath;
}

function runSchtasks(args: string[]): string {
  const result = spawnSync("schtasks.exe", args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Windows 计划任务命令失败。").trim());
  }
  return result.stdout.trim();
}

function runPowerShell(script: string): string {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Windows 计划任务配置失败。").trim());
  }
  return (result.stdout ?? "").trim();
}

type ScheduledTaskInfo = {
  installed: boolean;
  state: string | null;
  lastRunAt: string | null;
  lastResult: number | null;
  nextRunAt: string | null;
};

function readTaskInfo(commands: WorkerTaskCommands): ScheduledTaskInfo {
  const output = commands.powershell(TASK_INFO_SCRIPT).trim();
  const value = JSON.parse(output) as {
    installed?: unknown;
    state?: unknown;
    lastRunAt?: unknown;
    lastResult?: unknown;
    nextRunAt?: unknown;
  };
  return {
    installed: value.installed === true,
    state: typeof value.state === "string" ? value.state : null,
    lastRunAt: isoDateOrNull(value.lastRunAt),
    lastResult:
      typeof value.lastResult === "number" && Number.isFinite(value.lastResult)
        ? value.lastResult
        : null,
    nextRunAt: isoDateOrNull(value.nextRunAt),
  };
}

function isoDateOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function formatTaskTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function formatTaskResult(value: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

const TASK_INFO_SCRIPT = String.raw`
$task = Get-ScheduledTask -TaskName 'Person Agent' -ErrorAction SilentlyContinue
if (-not $task) {
  '{"installed":false}'
} else {
  $lastRun = $null
  $nextRun = $null
  $lastResult = $null
  try {
    $info = Get-ScheduledTaskInfo -TaskName 'Person Agent' -ErrorAction Stop
    if ($info.LastRunTime -and $info.LastRunTime.Year -gt 2000) {
      $lastRun = $info.LastRunTime.ToString('o')
    }
    if ($info.NextRunTime -and $info.NextRunTime.Year -gt 2000) {
      $nextRun = $info.NextRunTime.ToString('o')
    }
    $lastResult = [long]$info.LastTaskResult
  } catch {}
  @{
    installed = $true
    state = [string]$task.State
    lastRunAt = $lastRun
    lastResult = $lastResult
    nextRunAt = $nextRun
  } | ConvertTo-Json -Compress
}
`;

function requireWindows(): void {
  if (process.platform !== "win32") throw new Error("worker 服务安装仅支持 Windows。");
}
