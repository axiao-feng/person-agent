import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { appPaths } from "./paths.js";

export type NotificationAction =
  | { kind: "approval"; id: string }
  | { kind: "lecture"; id: string }
  | { kind: "today" };

export type Notifier = (
  title: string,
  body: string,
  action?: NotificationAction,
) => Promise<void>;

export const windowsNotifier: Notifier = async (title, body, action) => {
  if (process.platform !== "win32") throw new Error("系统通知仅支持 Windows。");
  const script = Buffer.from(POPUP_SCRIPT, "utf16le").toString("base64");
  const executable = desktopExecutable();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PERSON_AGENT_POPUP_TITLE: Buffer.from(title.slice(0, 200), "utf8").toString("base64"),
    PERSON_AGENT_POPUP_BODY: Buffer.from(body.slice(0, 8_000), "utf8").toString("base64"),
  };
  if (executable && action) {
    const launch = notificationLaunch(action);
    env.PERSON_AGENT_POPUP_EXE = Buffer.from(executable, "utf8").toString("base64");
    env.PERSON_AGENT_POPUP_MODE = Buffer.from(launch.mode, "utf8").toString("base64");
    env.PERSON_AGENT_POPUP_OBJECT = Buffer.from(launch.objectId, "utf8").toString("base64");
    env.PERSON_AGENT_POPUP_ACTION = Buffer.from(
      notificationActionLabel(action),
      "utf8",
    ).toString("base64");
  }
  // The popup outlives the worker's notification call. Redirect stderr to a
  // file instead of a pipe: a pipe closed when Node exits can make the
  // detached PowerShell process fail before WinForms shows the window.
  const errorLog = join(appPaths().root, "notification-errors.log");
  let errorFd: number | undefined;
  try {
    errorFd = openSync(errorLog, "a");
  } catch {
    // Notification delivery must not depend on diagnostics being writable.
  }
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(
        "powershell.exe",
        ["-STA", "-NoProfile", "-EncodedCommand", script],
        { env, stdio: ["ignore", "ignore", errorFd ?? "ignore"] },
      );
    } finally {
      if (errorFd !== undefined) closeSync(errorFd);
    }
    const startedAt = Date.now();
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(), 1_000);
    child.once("error", () => finish(new Error("无法启动 Windows 弹窗服务。")));
    child.once("close", (code) => {
      if (code === 0 && Date.now() - startedAt >= 500) finish();
      else if (code === 0) finish(new Error("Windows 弹窗进程过早退出，窗口未显示。"));
      else finish(new Error(`Windows 弹窗发送失败（${code ?? "unknown"}），详见 ${errorLog}。`));
    });
  });
};

/**
 * Resolves the WPF client registered by DesktopRegistration. A missing or
 * stale executable simply hides the deep-link button; the notification text
 * still tells the user where to look.
 */
export function desktopExecutable(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = environment.PERSON_AGENT_DESKTOP?.trim();
  if (configured && existsSync(configured)) return configured;
  for (const root of desktopRegistrationRoots(environment)) {
    const executable = readDesktopRegistration(join(root, "desktop.json"));
    if (executable) return executable;
  }
  return undefined;
}

/**
 * The worker loads the repository .env, while a normally launched client only
 * sees the user environment. Check the worker home first, then the standard
 * LocalAppData home the client also registers to.
 */
export function desktopRegistrationRoots(environment: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [appPaths(environment).root];
  const localAppData = environment.LOCALAPPDATA?.trim();
  if (localAppData) {
    roots.push(join(localAppData, "person-agent"));
  } else {
    const appData = environment.APPDATA?.trim();
    if (appData) roots.push(join(appData, "person-agent"));
  }
  return [...new Set(roots.map((root) => resolve(root)))];
}

function readDesktopRegistration(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { executable?: unknown };
    if (typeof value.executable === "string" && value.executable.trim()) {
      return existsSync(value.executable) ? value.executable : undefined;
    }
  } catch {
    // A partially written registration must not break notifications.
  }
  return undefined;
}

/** The WPF client accepts `--approval <id>`, `--lecture <id>`, or `--today`. */
export function notificationLaunch(action: NotificationAction): {
  mode: string;
  objectId: string;
} {
  return {
    mode: action.kind,
    objectId: "id" in action ? action.id : "",
  };
}

export function notificationActionLabel(action: NotificationAction): string {
  switch (action.kind) {
    case "approval":
      return "打开待审批";
    case "lecture":
      return "打开日历";
    case "today":
      return "打开今日";
  }
}

const POPUP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PERSON_AGENT_POPUP_TITLE))
$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PERSON_AGENT_POPUP_BODY))
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = $title
$form.Width = 760
$form.Height = 620
$form.MinimumSize = New-Object System.Drawing.Size(520, 360)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$content = New-Object System.Windows.Forms.RichTextBox
$content.Dock = 'Fill'
$content.ReadOnly = $true
$content.BackColor = [System.Drawing.Color]::White
$content.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11)
$content.Text = $body
$buttons = New-Object System.Windows.Forms.FlowLayoutPanel
$buttons.Dock = 'Bottom'
$buttons.Height = 54
$buttons.FlowDirection = 'RightToLeft'
$buttons.Padding = New-Object System.Windows.Forms.Padding(10, 9, 10, 9)
$close = New-Object System.Windows.Forms.Button
$close.Text = '关闭'
$close.Width = 96
$close.Height = 34
$close.Add_Click({ $form.Close() })
$buttons.Controls.Add($close)
if ($env:PERSON_AGENT_POPUP_EXE -and $env:PERSON_AGENT_POPUP_MODE) {
  $open = New-Object System.Windows.Forms.Button
  $open.Text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PERSON_AGENT_POPUP_ACTION))
  $open.Width = 150
  $open.Height = 34
  $open.Add_Click({
    try {
      $exe = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PERSON_AGENT_POPUP_EXE))
      $mode = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PERSON_AGENT_POPUP_MODE))
      $objectId = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PERSON_AGENT_POPUP_OBJECT))
      $argumentLine = "--$mode"
      if ($objectId) {
        $argumentLine = $argumentLine + ' "' + ($objectId -replace '"', '') + '"'
      }
      Start-Process -FilePath $exe -ArgumentList $argumentLine
    } catch {
      [System.Windows.Forms.MessageBox]::Show('无法打开 Person Agent 客户端。请手动启动后查看对应页面。', 'Person Agent')
    }
    $form.Close()
  })
  $buttons.Controls.Add($open)
}
$form.Controls.Add($content)
$form.Controls.Add($buttons)
$form.AcceptButton = $close
$form.CancelButton = $close
$form.Add_Shown({ $form.Activate(); $form.BringToFront() })
$null = $form.ShowDialog()
`;
