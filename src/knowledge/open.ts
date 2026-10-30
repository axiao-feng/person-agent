import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { localDateKey } from "../schedule.js";
import { dailyNotePath, knowledgeVault } from "./vault.js";

export type OpenNoteResult = {
  path: string;
  target: string;
  method: "obsidian" | "system";
};

export type OpenNoteDependencies = {
  platform?: NodeJS.Platform;
  obsidianInstalled?: () => boolean;
  exists?: (path: string) => boolean;
  launch?: (command: string, args: string[]) => void;
};

export function obsidianUri(filePath: string): string {
  return `obsidian://open?path=${encodeURIComponent(filePath)}`;
}

export function detectObsidian(
  environment: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): boolean {
  const localAppData = environment.LOCALAPPDATA;
  const programFiles = environment.ProgramFiles || environment.PROGRAMFILES;
  const programFilesX86 = environment["ProgramFiles(x86)"];
  const candidates = [
    localAppData ? join(localAppData, "Obsidian", "Obsidian.exe") : "",
    localAppData ? join(localAppData, "Programs", "Obsidian", "Obsidian.exe") : "",
    programFiles ? join(programFiles, "Obsidian", "Obsidian.exe") : "",
    programFilesX86 ? join(programFilesX86, "Obsidian", "Obsidian.exe") : "",
  ].filter(Boolean);
  return candidates.some((candidate) => fileExists(candidate));
}

export function openKnowledgeNote(filePath: string, dependencies: OpenNoteDependencies = {}): OpenNoteResult {
  const fileExists = dependencies.exists ?? existsSync;
  if (!fileExists(filePath)) {
    throw new Error(`找不到知识简报：${filePath}。请先运行 person-agent knowledge digest。`);
  }
  const platform = dependencies.platform ?? process.platform;
  const useObsidian = platform === "win32" && (dependencies.obsidianInstalled?.() ?? detectObsidian());
  const target = useObsidian ? obsidianUri(filePath) : filePath;
  const launch = dependencies.launch ?? launchChecked;
  if (platform === "win32") {
    launch("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      `Start-Process -FilePath '${escapePowerShell(target)}'`,
    ]);
  } else if (platform === "darwin") {
    launch("open", [target]);
  } else {
    launch("xdg-open", [target]);
  }
  return { path: filePath, target, method: useObsidian ? "obsidian" : "system" };
}

export function openTodayKnowledgeNote(
  vaultPath: string,
  now: Date,
  timezone: string,
  dependencies: OpenNoteDependencies = {},
): OpenNoteResult {
  const vault = knowledgeVault(vaultPath);
  const date = localDateKey(now, timezone);
  return openKnowledgeNote(dailyNotePath(vault, date), dependencies);
}

function escapePowerShell(value: string): string {
  return value.replace(/'/g, "''");
}

function launchChecked(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    stdio: "ignore",
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`系统无法打开知识简报（退出码 ${result.status ?? "unknown"}）。`);
}
