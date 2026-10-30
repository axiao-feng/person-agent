import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ensureAppDirectory, type AppPaths } from "./paths.js";

export type ThinkingLevel = "low" | "high" | "max";

export type AppConfig = {
  timezone: string;
  briefingTime: string;
  briefingEnabled?: boolean;
  thinkingLevel: ThinkingLevel;
  knowledgeVaultPath: string;
  knowledgeDigestTime: string;
  knowledgeDigestEnabled?: boolean;
  location?: {
    city: string;
    latitude: number;
    longitude: number;
    timezone: string;
  };
};

export const DEFAULT_KNOWLEDGE_VAULT_PATH = join(homedir(), "Documents", "Person Agent Knowledge");

export const DEFAULT_CONFIG: AppConfig = {
  timezone: "Asia/Shanghai",
  briefingTime: "07:30",
  briefingEnabled: true,
  thinkingLevel: "low",
  knowledgeVaultPath: DEFAULT_KNOWLEDGE_VAULT_PATH,
  knowledgeDigestTime: "22:30",
  knowledgeDigestEnabled: true,
};

export function briefingEnabled(config: AppConfig): boolean {
  return config.briefingEnabled !== false;
}

export function knowledgeDigestEnabled(config: AppConfig): boolean {
  return config.knowledgeDigestEnabled !== false;
}

export function loadConfig(paths: AppPaths): AppConfig {
  try {
    const value: unknown = JSON.parse(readFileSync(paths.config, "utf8"));
    if (!value || typeof value !== "object") return { ...DEFAULT_CONFIG };
    const input = value as Record<string, unknown>;
    const location = parseLocation(input.location);
    return {
      timezone: stringOr(input.timezone, DEFAULT_CONFIG.timezone),
      briefingTime: timeOr(input.briefingTime, DEFAULT_CONFIG.briefingTime),
      briefingEnabled: booleanOr(input.briefingEnabled, true),
      thinkingLevel: thinkingOr(input.thinkingLevel),
      knowledgeVaultPath: stringOr(input.knowledgeVaultPath, DEFAULT_CONFIG.knowledgeVaultPath),
      knowledgeDigestTime: timeOr(input.knowledgeDigestTime, DEFAULT_CONFIG.knowledgeDigestTime),
      knowledgeDigestEnabled: booleanOr(input.knowledgeDigestEnabled, true),
      ...(location ? { location } : {}),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(paths: AppPaths, config: AppConfig): void {
  ensureAppDirectory(paths);
  writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function parseLocation(value: unknown): AppConfig["location"] {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (
    typeof item.city !== "string" ||
    typeof item.latitude !== "number" ||
    typeof item.longitude !== "number" ||
    typeof item.timezone !== "string"
  ) {
    return undefined;
  }
  return {
    city: item.city,
    latitude: item.latitude,
    longitude: item.longitude,
    timezone: item.timezone,
  };
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function timeOr(value: unknown, fallback: string): string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
    ? value
    : fallback;
}

function thinkingOr(value: unknown): ThinkingLevel {
  return value === "high" || value === "max" || value === "low" ? value : "low";
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
