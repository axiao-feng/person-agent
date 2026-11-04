import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AppConfig } from "../src/config.js";
import { AppDatabase } from "../src/database.js";
import type { AppPaths } from "../src/paths.js";
import { startLocalServer, type LocalServerOptions } from "../src/server/local-server.js";
import type { CalendarSource } from "../src/server/sources.js";
import type { HealthResponse, TodayResponse } from "../src/server/types.js";

const NOW = new Date("2026-10-30T02:00:00.000Z");
const TOKEN = "test-session-token";

test("today aggregates real local data, calendar events, and pending approvals", async () => {
  await withFixture(async (fixture) => {
    const response = await fixture.get("/api/today?date=2026-10-30");
    assert.equal(response.status, 200);
    const today = (await response.json()) as TodayResponse;
    assert.equal(today.status, "success");
    assert.equal(today.date, "2026-10-30");
    assert.equal(today.timezone, "Asia/Shanghai");
    assert.ok(today.requestId);
    assert.ok(today.generatedAt);

    const planned = fixture.plannedTaskId;
    assert.deepEqual(
      today.focusItems.map((item) => item.reasonCode),
      ["in_progress", "planned_today", "due_today"],
    );
    assert.equal(today.focusItems[1]?.id, planned);
    assert.equal(today.timeline[0]?.allDay, false);

    const google = today.timeline.find((item) => item.id === "google:evt-1");
    assert.ok(google);
    assert.equal(google.linkedObjectId, planned);
    assert.equal(
      today.timeline.some((item) => item.id === `task:${planned}`),
      false,
      "the planned task should merge into its calendar event",
    );
    assert.ok(today.timeline.some((item) => item.id === `lecture:${fixture.lectureId}`));
    assert.ok(today.timeline.some((item) => item.id === "automation:daily-briefing"));
    assert.ok(today.timeline.some((item) => item.id === "automation:knowledge-digest"));

    const approval = today.timeline.find((item) => item.id === `approval:${fixture.actionId}`);
    assert.ok(approval);
    assert.equal(approval.detail, "待审批 · 尚未写入 Calendar");
    assert.equal(today.approvals.length, 1);
    assert.equal(today.approvals[0]?.display.target, "Google Calendar");
    assert.equal(today.approvals[0]?.display.originalStart, null);
    assert.equal(today.approvals[0]?.display.proposedStart, "2026-10-30T07:00:00.000Z");

    assert.equal(today.knowledgeItems.length, 1);
    assert.equal(today.knowledgeItems[0]?.key, "PAPER1");
    assert.equal(today.knowledgeItems[0]?.evidenceState, "pending");
    assert.equal(today.weather?.city, "上海");
    assert.equal(today.sources.calendar?.state, "available");
    assert.equal(today.sources.weather?.state, "available");
  });
});

test("health reports service, worker, and connection states without secrets", async () => {
  await withFixture(async (fixture) => {
    const response = await fixture.get("/api/health");
    assert.equal(response.status, 200);
    const health = (await response.json()) as HealthResponse;
    assert.equal(health.status, "ok");
    assert.equal(health.service.protocolVersion, "1");
    assert.equal(health.service.version, "0.6.0");
    assert.equal(health.service.uptimeSeconds >= 0, true);
    assert.equal(health.worker.state, "stopped");
    assert.equal(health.connections.database.state, "available");
    assert.equal(health.connections.vault.state, "available");
    assert.equal(health.connections.zotero.state, "available");
    assert.equal(health.connections.googleCalendar.state, "not_configured");
    assert.equal(health.connections.deepSeek.state, "not_configured");
    assert.equal(JSON.stringify(health).includes(TOKEN), false);
  });
});

test("today returns a valid empty snapshot when there is no local data", async () => {
  await withFixture(
    async (fixture) => {
      const response = await fixture.get("/api/today?date=2026-10-30");
      assert.equal(response.status, 200);
      const today = (await response.json()) as TodayResponse;
      assert.equal(today.status, "success");
      assert.deepEqual(today.focusItems, []);
      assert.deepEqual(today.timeline, []);
      assert.deepEqual(today.knowledgeItems, []);
      assert.deepEqual(today.approvals, []);
    },
    {
      seed: false,
      calendar: {
        async list() {
          return [];
        },
      },
    },
  );
});

test("rejects missing token, cross-site origins, invalid dates, and wrong methods", async () => {
  await withFixture(async (fixture) => {
    const unauthenticated = await fetch(`${fixture.baseUrl}/api/health`);
    assert.equal(unauthenticated.status, 401);
    const unauthorizedBody = (await unauthenticated.json()) as {
      requestId: string;
      error: { code: string; retryable: boolean };
    };
    assert.equal(unauthorizedBody.error.code, "UNAUTHORIZED");
    assert.equal(unauthorizedBody.error.retryable, false);
    assert.ok(unauthorizedBody.requestId);

    const crossSite = await fetch(`${fixture.baseUrl}/api/health`, {
      headers: {
        "X-Person-Agent-Token": TOKEN,
        Origin: "http://example.com",
      },
    });
    assert.equal(crossSite.status, 403);

    const invalidDate = await fixture.get("/api/today?date=2026-02-30");
    assert.equal(invalidDate.status, 400);
    const invalidBody = (await invalidDate.json()) as {
      error: { code: string; fieldErrors?: Record<string, string> };
    };
    assert.equal(invalidBody.error.code, "VALIDATION_FAILED");
    assert.ok(invalidBody.error.fieldErrors?.date);

    const wrongMethod = await fetch(`${fixture.baseUrl}/api/today`, {
      method: "POST",
      headers: { "X-Person-Agent-Token": TOKEN },
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");
  });
});

test("today stays partial and keeps local data when calendar and weather fail", async () => {
  await withFixture(
    async (fixture) => {
      const response = await fixture.get("/api/today?date=2026-10-30");
      assert.equal(response.status, 200);
      const today = (await response.json()) as TodayResponse;
      assert.equal(today.status, "partial");
      assert.equal(today.sources.calendar?.state, "unavailable");
      assert.equal(today.sources.weather?.state, "unavailable");
      assert.equal(today.weather, null);
      assert.equal(today.focusItems.length, 3);
      assert.ok(today.timeline.some((item) => item.id === `lecture:${fixture.lectureId}`));
      assert.ok(today.timeline.some((item) => item.id === `task:${fixture.plannedTaskId}`));
      assert.equal(
        today.timeline.some((item) => item.source === "google"),
        false,
      );
    },
    {
      calendar: {
        async list() {
          throw new Error("calendar offline");
        },
      },
      weather: async () => {
        throw new Error("weather offline");
      },
    },
  );
});

type FixtureOptions = {
  seed?: boolean;
  calendar?: CalendarSource;
  weather?: LocalServerOptions["weather"];
};

type Fixture = {
  baseUrl: string;
  get(path: string, headers?: Record<string, string>): Promise<Response>;
  plannedTaskId: string;
  lectureId: string;
  actionId: string;
};

async function withFixture(
  operation: (fixture: Fixture) => Promise<void>,
  options: FixtureOptions = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "person-agent-server-test-"));
  const vault = join(root, "vault");
  mkdirSync(vault, { recursive: true });
  const paths: AppPaths = {
    root,
    config: join(root, "config.json"),
    database: join(root, "agent.db"),
    secrets: join(root, "secrets.dpapi"),
    log: join(root, "worker.log"),
  };
  const config: AppConfig = {
    timezone: "Asia/Shanghai",
    briefingTime: "07:30",
    thinkingLevel: "low",
    knowledgeVaultPath: vault,
    knowledgeDigestTime: "22:30",
    location: { city: "上海", latitude: 31.2304, longitude: 121.4737, timezone: "Asia/Shanghai" },
  };
  writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const database = new AppDatabase(paths.database);
  const seeded =
    options.seed === false
      ? { plannedTaskId: "", lectureId: "", actionId: "" }
      : seed(database, config);
  const server = await startLocalServer({
    token: TOKEN,
    paths,
    config,
    database,
    now: () => NOW,
    calendar:
      options.calendar ??
      ({
        async list() {
          return [
            {
              id: "evt-1",
              calendar: "primary",
              title: "阅读论文",
              description: null,
              location: null,
              start: "2026-10-30T02:00:00.000Z",
              end: "2026-10-30T03:00:00.000Z",
              allDay: false,
              status: "confirmed",
              attendees: [],
            },
          ];
        },
      } satisfies CalendarSource),
    ...(options.weather
      ? { weather: options.weather }
      : {
          weather: async (location) => ({
            location,
            current: {
              time: "2026-10-30T10:00",
              temperature: 21,
              apparentTemperature: 20,
              precipitationProbability: 10,
              windSpeed: 8,
              weatherCode: 0,
              condition: "晴",
            },
            hourly: [],
          }),
        }),
    probes: {
      zotero: async () => ({ state: "available", updatedAt: null, message: null }),
      worker: () => ({ state: "stopped", lastRunAt: null }),
      deepSeek: async () => ({ state: "not_configured", updatedAt: null, message: null }),
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  try {
    await operation({
      baseUrl,
      get: (path, headers = {}) =>
        fetch(`${baseUrl}${path}`, {
          headers: { "X-Person-Agent-Token": TOKEN, ...headers },
        }),
      ...seeded,
    });
  } finally {
    await server.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function seed(database: AppDatabase, config: AppConfig) {
  const inProgress = database.createResearchTask(
    { title: "推进实验", estimatedMinutes: 90, priority: "high" },
    NOW,
  );
  database.updateResearchTask(inProgress.id, { status: "in_progress" }, NOW);

  const planned = database.createResearchTask(
    { title: "阅读论文", estimatedMinutes: 60, priority: "medium" },
    NOW,
  );
  database.updateResearchTask(
    planned.id,
    {
      status: "planned",
      plannedStart: "2026-10-30T02:00:00.000Z",
      plannedEnd: "2026-10-30T03:00:00.000Z",
      calendarEventId: "evt-1",
    },
    NOW,
  );

  database.createResearchTask(
    {
      title: "提交作业",
      taskKind: "assignment",
      deadline: "2026-10-30T10:00:00.000Z",
      estimatedMinutes: 30,
      priority: "high",
    },
    NOW,
  );

  const lecture = database.createLecture(
    {
      title: "组会",
      startAt: "2026-10-30T06:00:00.000Z",
      endAt: "2026-10-30T07:00:00.000Z",
      location: "会议室",
      requiresPresentation: true,
    },
    NOW,
  );

  const action = database.stageWorkflowAction(
    "calendar.create",
    {
      title: "阅读论文",
      startAt: "2026-10-30T07:00:00.000Z",
      endAt: "2026-10-30T08:00:00.000Z",
      taskId: planned.id,
    },
    NOW,
  );

  database.upsertZoteroPaper(
    {
      key: "PAPER1",
      version: 1,
      itemType: "journalArticle",
      title: "世界模型综述",
      creators: [{ creatorType: "author", firstName: "Ada", lastName: "Lovelace", name: "" }],
      date: "2026",
      abstract: "摘要",
      doi: null,
      url: null,
      tags: ["世界模型"],
    },
    NOW,
  );
  database.ensureDailyBriefing(config, NOW);
  database.ensureKnowledgeDigest(config, NOW);

  return {
    plannedTaskId: planned.id,
    lectureId: lecture.id,
    actionId: action.id,
  };
}
