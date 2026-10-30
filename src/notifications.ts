import { spawn } from "node:child_process";

export type Notifier = (title: string, body: string) => Promise<void>;

export const windowsNotifier: Notifier = async (title, body) => {
  if (process.platform !== "win32") throw new Error("系统通知仅支持 Windows。");
  const script = Buffer.from(POPUP_SCRIPT, "utf16le").toString("base64");
  const env = {
    ...process.env,
    PERSON_AGENT_POPUP_TITLE: Buffer.from(title.slice(0, 200), "utf8").toString("base64"),
    PERSON_AGENT_POPUP_BODY: Buffer.from(body.slice(0, 8_000), "utf8").toString("base64"),
  };
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-STA", "-NoProfile", "-EncodedCommand", script],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    const startedAt = Date.now();
    let settled = false;
    let errorOutput = "";
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr.destroy();
      child.unref();
      if (error) reject(error);
      else resolve();
    };
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (errorOutput += chunk));
    const timer = setTimeout(() => finish(), 1_000);
    child.once("error", () => finish(new Error("无法启动 Windows 弹窗服务。")));
    child.once("close", (code) => {
      if (code === 0 && Date.now() - startedAt >= 500) finish();
      else if (code === 0) finish(new Error("Windows 弹窗进程过早退出，窗口未显示。"));
      else finish(new Error(errorOutput.trim() || `Windows 弹窗发送失败（${code ?? "unknown"}）。`));
    });
  });
};

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
$form.Height = 600
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$content = New-Object System.Windows.Forms.RichTextBox
$content.Dock = 'Fill'
$content.ReadOnly = $true
$content.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11)
$content.Text = $body
$close = New-Object System.Windows.Forms.Button
$close.Text = '关闭'
$close.Dock = 'Bottom'
$close.Height = 44
$close.Add_Click({ $form.Close() })
$form.Controls.Add($content)
$form.Controls.Add($close)
$form.AcceptButton = $close
$form.Add_Shown({ $form.Activate(); $form.BringToFront() })
$null = $form.ShowDialog()
`;
