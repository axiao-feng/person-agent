import type { AppConfig } from "../../config.js";
import { saveConfig } from "../../config.js";
import { KNOWLEDGE_DIGEST_JOB_ID, type ScheduledJob } from "../../database.js";
import { ensureKnowledgeVault } from "../../knowledge/vault.js";
import type { Route, RouteRequest } from "../context.js";
import { collectHealth } from "../health.js";
import { objectBody, optionalBooleanField, validation } from "../http.js";
import type { AutomationSetting, Settings, SourceStatus } from "../types.js";

const BRIEFING_JOB_ID = "daily-briefing";

export const settingsRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/settings",
    async handler(request) {
      return { body: { settings: await buildSettings(request) } };
    },
  },
  {
    method: "PATCH",
    pattern: "/api/settings",
    async handler(request) {
      const body = objectBody(request.body);
      const next: AppConfig = { ...request.runtime.config };

      if ("timezone" in body) {
        next.timezone = timezoneValue(body.timezone, "时区");
      }
      if ("knowledgeVaultPath" in body) {
        const path = typeof body.knowledgeVaultPath === "string" ? body.knowledgeVaultPath.trim() : "";
        if (!path) throw validation("知识库目录不能为空。", "knowledgeVaultPath");
        try {
          ensureKnowledgeVault(path);
        } catch (error) {
          throw validation(
            `知识库目录不可用：${error instanceof Error ? error.message : "未知错误"}`,
            "knowledgeVaultPath",
          );
        }
        next.knowledgeVaultPath = path;
      }
      if ("location" in body) {
        if (body.location === null) {
          delete next.location;
        } else {
          const location = body.location;
          if (!location || typeof location !== "object" || Array.isArray(location)) {
            throw validation("location 必须是对象或 null。", "location");
          }
          const item = location as Record<string, unknown>;
          const city = typeof item.city === "string" ? item.city.trim() : "";
          if (!city) throw validation("城市不能为空。", "location.city");
          const latitude = item.latitude;
          const longitude = item.longitude;
          if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
            throw validation("纬度必须在 -90 到 90 之间。", "location.latitude");
          }
          if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
            throw validation("经度必须在 -180 到 180 之间。", "location.longitude");
          }
          next.location = {
            city,
            latitude,
            longitude,
            timezone: timezoneValue(item.timezone, "城市时区"),
          };
        }
      }
      applyAutomation(body, "briefing", next, "briefing");
      applyAutomation(body, "knowledgeDigest", next, "knowledgeDigest");

      try {
        saveConfig(request.paths, next);
      } catch (error) {
        throw validation(`设置保存失败：${error instanceof Error ? error.message : "未知错误"}`);
      }
      request.runtime.config = next;
      request.database.ensureDailyBriefing(next, request.now);
      request.database.ensureKnowledgeDigest(next, request.now);
      return { body: { settings: await buildSettings(request) } };
    },
  },
];

async function buildSettings(request: RouteRequest): Promise<Settings> {
  const config = request.runtime.config;
  request.database.ensureDailyBriefing(config, request.now);
  request.database.ensureKnowledgeDigest(config, request.now);
  const health = await collectHealth({
    paths: request.paths,
    config,
    database: request.database,
    startedAt: request.startedAt,
    requestId: request.requestId,
    now: () => new Date(),
    ...(request.services.probes ? { probes: request.services.probes } : {}),
  });
  const briefingJob = request.database.getJob(BRIEFING_JOB_ID);
  const digestJob = request.database.getJob(KNOWLEDGE_DIGEST_JOB_ID);
  return {
    timezone: config.timezone,
    knowledgeVaultPath: config.knowledgeVaultPath,
    location: config.location
      ? {
          city: config.location.city,
          latitude: config.location.latitude,
          longitude: config.location.longitude,
          timezone: config.location.timezone,
        }
      : null,
    automations: {
      briefing: automation(request, briefingJob, config.briefingTime, config.briefingEnabled !== false),
      knowledgeDigest: automation(
        request,
        digestJob,
        config.knowledgeDigestTime,
        config.knowledgeDigestEnabled !== false,
      ),
    },
    connections: health.connections as unknown as Record<string, SourceStatus>,
  };
}

function automation(
  request: RouteRequest,
  job: ScheduledJob | undefined,
  fallbackTime: string,
  fallbackEnabled: boolean,
): AutomationSetting {
  const run = job ? request.database.getLatestJobRun(job.id) : undefined;
  const lastResult =
    run?.status === "delivered" || run?.status === "failed" || run?.status === "skipped"
      ? run.status
      : null;
  return {
    enabled: job?.enabled ?? fallbackEnabled,
    time: job?.schedule.kind === "daily" ? job.schedule.time : fallbackTime,
    lastRunAt: run?.completedAt ?? null,
    lastResult,
    nextRunAt: job?.nextRunAt ?? null,
  };
}

function applyAutomation(
  body: Record<string, unknown>,
  key: "briefing" | "knowledgeDigest",
  config: AppConfig,
  target: "briefing" | "knowledgeDigest",
): void {
  if (!(key in body) || body[key] === undefined) return;
  const value = body[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validation(`${key} 必须是对象。`, key);
  }
  const item = value as Record<string, unknown>;
  const enabled = optionalBooleanField(item, "enabled", `${key}.enabled`);
  const time = "time" in item ? clockTime(item.time, `${key}.time`) : undefined;
  if (target === "briefing") {
    if (enabled !== undefined) config.briefingEnabled = enabled;
    if (time !== undefined) config.briefingTime = time;
  } else {
    if (enabled !== undefined) config.knowledgeDigestEnabled = enabled;
    if (time !== undefined) config.knowledgeDigestTime = time;
  }
}

function clockTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw validation(`${label} 必须使用 HH:mm 格式。`, label);
  }
  return value;
}

function timezoneValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw validation(`${label}不能为空。`, label);
  }
  const timezone = value.trim();
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw validation(`${label}无效。`, label);
  }
  return timezone;
}
