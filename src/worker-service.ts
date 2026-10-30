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
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Set-ScheduledTask -TaskName '${TASK_NAME}' -Settings $settings | Out-Null
$task = Get-ScheduledTask -TaskName '${TASK_NAME}'
$task.Triggers[0].Delay = 'PT2M'
$task | Set-ScheduledTask | Out-Null
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
  return commands.schtasks(["/Query", "/TN", TASK_NAME, "/FO", "LIST", "/V"]);
}

/**
 * Report whether the Windows worker task is currently running. "Ready" only
 * means the task is installed and waiting, never that the worker process is
 * alive, so it maps to "stopped".
 */
export function workerTaskHealth(commands: WorkerTaskCommands = defaultCommands): WorkerRuntimeHealth {
  if (process.platform !== "win32") return { state: "unknown", lastRunAt: null };
  try {
    const output = commands.powershell(HEALTH_SCRIPT).trim();
    const value = JSON.parse(output) as { state?: unknown; lastRunAt?: unknown };
    if (value.state !== "running" && value.state !== "stopped" && value.state !== "not_installed") {
      return { state: "unknown", lastRunAt: null };
    }
    const lastRun = typeof value.lastRunAt === "string" ? new Date(value.lastRunAt) : undefined;
    return {
      state: value.state,
      lastRunAt: lastRun && !Number.isNaN(lastRun.getTime()) ? lastRun.toISOString() : null,
    };
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

const HEALTH_SCRIPT = String.raw`
$task = Get-ScheduledTask -TaskName 'Person Agent' -ErrorAction SilentlyContinue
if (-not $task) {
  '{"state":"not_installed","lastRunAt":null}'
} else {
  $state = [string]$task.State
  $lastRun = $null
  try {
    $info = Get-ScheduledTaskInfo -TaskName 'Person Agent' -ErrorAction Stop
    if ($info.LastRunTime -and $info.LastRunTime.Year -gt 2000) {
      $lastRun = $info.LastRunTime.ToString('o')
    }
  } catch {}
  if ($state -eq 'Running' -or $state -eq 'Queued') {
    $mapped = 'running'
  } elseif ($state -eq 'Unknown') {
    $mapped = 'unknown'
  } else {
    $mapped = 'stopped'
  }
  @{ state = $mapped; lastRunAt = $lastRun } | ConvertTo-Json -Compress
}
`;

function requireWindows(): void {
  if (process.platform !== "win32") throw new Error("worker 服务安装仅支持 Windows。");
}
