import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

import type { Credentials } from "google-auth-library";

import { ensureAppDirectory, type AppPaths } from "./paths.js";

export type AppSecrets = {
  deepseekApiKey?: string;
  google?: {
    clientId: string;
    clientSecret?: string;
    tokens: Credentials;
  };
};

export async function loadSecrets(paths: AppPaths): Promise<AppSecrets> {
  if (!existsSync(paths.secrets)) return {};
  if (process.platform !== "win32") {
    throw new Error("本地凭据使用 Windows DPAPI，只支持 Windows。");
  }
  const encrypted = readFileSync(paths.secrets, "utf8").trim();
  if (!encrypted) return {};
  const json = await runPowerShell(DPAPI_DECRYPT, encrypted);
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object") throw new Error("本地凭据格式无效。");
  return value as AppSecrets;
}

export async function saveSecrets(paths: AppPaths, secrets: AppSecrets): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("本地凭据使用 Windows DPAPI，只支持 Windows。");
  }
  ensureAppDirectory(paths);
  const encrypted = await runPowerShell(DPAPI_ENCRYPT, JSON.stringify(secrets));
  const temporary = `${paths.secrets}.tmp`;
  writeFileSync(temporary, `${encrypted}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, paths.secrets);
}

export async function deepSeekApiKey(paths: AppPaths): Promise<string | undefined> {
  const fromEnvironment = process.env.DEEPSEEK_API_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;
  return (await loadSecrets(paths)).deepseekApiKey?.trim() || undefined;
}

async function runPowerShell(script: string, input: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (errorOutput += chunk));
    child.once("error", () => reject(new Error("无法启动 Windows 凭据加密服务。")));
    child.once("close", (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`Windows 凭据加密失败${errorOutput.trim() ? `：${errorOutput.trim()}` : "。"}`));
    });
    child.stdin.end(input, "utf8");
  });
}

const DPAPI_ENCRYPT = String.raw`
Add-Type -AssemblyName System.Security
$text = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($text)
$protected = [System.Security.Cryptography.ProtectedData]::Protect(
  $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($protected))
`;

const DPAPI_DECRYPT = String.raw`
Add-Type -AssemblyName System.Security
$encoded = [Console]::In.ReadToEnd().Trim()
$protected = [Convert]::FromBase64String($encoded)
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`;
