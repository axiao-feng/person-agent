import { accessSync, constants, existsSync } from "node:fs";

import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../database.js";
import type { AppPaths } from "../paths.js";
import { deepSeekApiKey, loadSecrets } from "../secrets.js";
import { workerTaskHealth, type WorkerRuntimeHealth } from "../worker-service.js";
import { safeErrorMessage } from "./errors.js";
import { probeZotero } from "./sources.js";
import {
  PROTOCOL_VERSION,
  type HealthConnections,
  type HealthResponse,
  type SourceStatus,
  type WorkerInfo,
} from "./types.js";
import { packageVersion } from "./version.js";

export type HealthProbes = {
  zotero?: () => Promise<SourceStatus>;
  worker?: () => WorkerRuntimeHealth | Promise<WorkerRuntimeHealth>;
  deepSeek?: () => Promise<SourceStatus>;
  googleCalendar?: () => Promise<SourceStatus>;
  gmail?: () => Promise<SourceStatus>;
};

export type HealthOptions = {
  paths: AppPaths;
  config: AppConfig;
  database: AppDatabase;
  startedAt: number;
  requestId: string;
  probes?: HealthProbes;
  now?: () => Date;
};

export async function collectHealth(options: HealthOptions): Promise<HealthResponse> {
  const now = options.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  const probes = options.probes ?? {};

  const [google, zotero, worker, deepSeek] = await Promise.all([
    googleConnectionStatuses(options.paths, probes),
    runProbe(probes.zotero ?? probeZotero, "Zotero 状态检查失败。"),
    runWorkerProbe(probes.worker),
    runProbe(probes.deepSeek ?? (() => deepSeekStatus(options.paths)), "DeepSeek 状态检查失败。"),
  ]);

  const connections: HealthConnections = {
    database: databaseStatus(options.database),
    vault: vaultStatus(options.config.knowledgeVaultPath),
    zotero,
    googleCalendar: google.calendar,
    gmail: google.gmail,
    deepSeek,
    weather: options.config.location
      ? available(null)
      : notConfigured("未配置城市。"),
  };
  const workerInfo: WorkerInfo = {
    state: worker.state,
    lastRunAt: worker.lastRunAt,
  };
  const degraded = Object.values(connections).some((connection) => connection.state === "unavailable");
  return {
    requestId: options.requestId,
    generatedAt,
    status: degraded ? "degraded" : "ok",
    service: {
      version: packageVersion(),
      protocolVersion: PROTOCOL_VERSION,
      uptimeSeconds: Math.max(0, Math.floor((now().getTime() - options.startedAt) / 1_000)),
    },
    worker: workerInfo,
    connections,
  };
}

async function runProbe(
  probe: () => Promise<SourceStatus>,
  message: string,
): Promise<SourceStatus> {
  try {
    return await probe();
  } catch (error) {
    return { state: "unknown", updatedAt: null, message: safeErrorMessage(error, message) };
  }
}

async function runWorkerProbe(
  probe: HealthProbes["worker"],
): Promise<WorkerRuntimeHealth> {
  try {
    return await (probe ? probe() : workerTaskHealth());
  } catch {
    return { state: "unknown", lastRunAt: null };
  }
}

function databaseStatus(database: AppDatabase): SourceStatus {
  try {
    database.sqlite.prepare("SELECT 1 AS ok").get();
    return available(null);
  } catch (error) {
    return unavailable(safeErrorMessage(error, "本地数据库不可用。"));
  }
}

function vaultStatus(path: string): SourceStatus {
  if (!path.trim()) return notConfigured("尚未配置知识库目录。");
  if (!existsSync(path)) return unavailable("知识库目录不存在。");
  try {
    accessSync(path, constants.W_OK);
    return available(null);
  } catch {
    return unavailable("知识库目录不可写。");
  }
}

async function deepSeekStatus(paths: AppPaths): Promise<SourceStatus> {
  try {
    return (await deepSeekApiKey(paths))
      ? available(null)
      : notConfigured("未配置 DeepSeek API key。");
  } catch (error) {
    return { state: "unknown", updatedAt: null, message: safeErrorMessage(error, "无法读取 DeepSeek 配置。") };
  }
}

async function googleConnectionStatuses(
  paths: AppPaths,
  probes: HealthProbes,
): Promise<{ calendar: SourceStatus; gmail: SourceStatus }> {
  if (probes.googleCalendar || probes.gmail) {
    return {
      calendar: probes.googleCalendar
        ? await runProbe(probes.googleCalendar, "Google Calendar 状态检查失败。")
        : notConfigured("Google 尚未连接。"),
      gmail: probes.gmail
        ? await runProbe(probes.gmail, "Gmail 状态检查失败。")
        : notConfigured("Google 尚未连接。"),
    };
  }
  try {
    const secrets = await loadSecrets(paths);
    if (!secrets.google) {
      return {
        calendar: notConfigured("Google 尚未连接。"),
        gmail: notConfigured("Google 尚未连接。"),
      };
    }
    const scope = typeof secrets.google.tokens.scope === "string" ? secrets.google.tokens.scope : "";
    if (!scope) {
      const message = "无法确认 Google 授权范围，请重新授权。";
      return { calendar: unknown(message), gmail: unknown(message) };
    }
    const scopes = new Set(scope.split(/\s+/).filter(Boolean));
    const calendarGranted =
      scopes.has("https://www.googleapis.com/auth/calendar.events") ||
      scopes.has("https://www.googleapis.com/auth/calendar.readonly");
    const gmailGranted = scopes.has("https://www.googleapis.com/auth/gmail.readonly");
    return {
      calendar: calendarGranted
        ? available(null)
        : unavailable("Google 授权缺少 Calendar 权限，请重新授权。"),
      gmail: gmailGranted
        ? available(null)
        : unavailable("Google 授权缺少 Gmail 只读权限，请重新授权。"),
    };
  } catch (error) {
    const message = safeErrorMessage(error, "无法读取 Google 授权状态。");
    return { calendar: unknown(message), gmail: unknown(message) };
  }
}

function available(message: string | null): SourceStatus {
  return { state: "available", updatedAt: new Date().toISOString(), message };
}

function notConfigured(message: string): SourceStatus {
  return { state: "not_configured", updatedAt: null, message };
}

function unavailable(message: string): SourceStatus {
  return { state: "unavailable", updatedAt: null, message };
}

function unknown(message: string): SourceStatus {
  return { state: "unknown", updatedAt: null, message };
}
