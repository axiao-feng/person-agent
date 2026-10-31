import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AppDatabase } from "../src/database.js";
import type { NotificationAction } from "../src/notifications.js";
import { nextOccurrence } from "../src/schedule.js";
import { processDueJobs } from "../src/worker.js";

test("computes daily and weekly occurrences in Asia/Shanghai", () => {
  const after = new Date("2026-09-20T00:00:00.000Z"); // Sunday 08:00 local
  assert.equal(
    nextOccurrence({ kind: "daily", time: "07:30" }, after, "Asia/Shanghai")?.toISOString(),
    "2026-09-20T23:30:00.000Z",
  );
  assert.equal(
    nextOccurrence({ kind: "weekly", time: "09:00", weekdays: [1] }, after, "Asia/Shanghai")?.toISOString(),
    "2026-09-21T01:00:00.000Z",
  );
});

test("lecture reminders are rescheduled and cancelled with the lecture", () => {
  withDatabase((database) => {
    const now = new Date("2026-09-20T02:00:00.000Z");
    const lecture = database.createLecture(
      { title: "机器人讲座", startAt: "2026-09-22T19:00:00+08:00", location: "报告厅" },
      now,
    );
    assert.equal(database.listDueJobs(new Date("2026-09-21T11:00:00.000Z")).length, 1);

    database.updateLecture(lecture.id, { startAt: "2026-09-23T19:00:00+08:00" }, now);
    assert.equal(database.listDueJobs(new Date("2026-09-21T11:00:00.000Z")).length, 0);
    assert.equal(database.listDueJobs(new Date("2026-09-22T11:00:00.000Z")).length, 1);

    database.cancelLecture(lecture.id, now);
    assert.equal(database.listDueJobs(new Date("2026-09-24T00:00:00.000Z")).length, 0);
  });
});

test("presentation meetings add a 72-hour reminder and omit the old 2-hour reminder", () => {
  withDatabase((database) => {
    const now = new Date("2026-09-20T02:00:00.000Z");
    const meeting = database.createLecture(
      {
        title: "课题组组会",
        startAt: "2026-09-25T15:00:00+08:00",
        requiresPresentation: true,
      },
      now,
    );
    assert.equal(meeting.requiresPresentation, true);
    const jobs = database.sqlite
      .prepare("SELECT body FROM jobs WHERE source_id = ? AND enabled = 1 ORDER BY next_run_at")
      .all(meeting.id) as Array<{ body: string }>;
    assert.deepEqual(
      jobs.map((job) => job.body),
      ["讲座将在 72 小时后开始。", "讲座将在 24 小时后开始。"],
    );

    database.updateLecture(meeting.id, { requiresPresentation: false }, now);
    const updatedJobs = database.sqlite
      .prepare("SELECT body FROM jobs WHERE source_id = ? AND enabled = 1 ORDER BY next_run_at")
      .all(meeting.id) as Array<{ body: string }>;
    assert.deepEqual(
      updatedJobs.map((job) => job.body),
      ["讲座将在 24 小时后开始。"],
    );
  });
});

test("completed reminder run is not claimed twice", () => {
  withDatabase((database) => {
    const createdAt = new Date("2026-09-20T00:00:00.000Z");
    const job = database.createReminder(
      {
        title: "提交周报",
        schedule: { kind: "once", at: "2026-09-20T01:00:00.000Z" },
        timezone: "Asia/Shanghai",
      },
      createdAt,
    );
    const due = database.listDueJobs(new Date("2026-09-20T01:00:00.000Z"));
    assert.equal(due.length, 1);
    const runId = database.beginRun(job, job.nextRunAt!, new Date("2026-09-20T01:00:00.000Z"));
    assert.ok(runId);
    database.completeRun(runId, "delivered", null, new Date("2026-09-20T01:00:01.000Z"));
    database.advanceJob(job, job.nextRunAt!, new Date("2026-09-20T01:00:01.000Z"));
    assert.equal(database.beginRun(job, job.nextRunAt!, new Date("2026-09-20T01:01:00.000Z")), undefined);
    assert.equal(database.listDueJobs(new Date("2026-09-21T00:00:00.000Z")).length, 0);
  });
});

test("a completed run advances a schedule after a crash before advanceJob", () => {
  withDatabase((database) => {
    const job = database.createReminder(
      {
        title: "恢复测试",
        schedule: { kind: "once", at: "2026-09-20T01:00:00.000Z" },
        timezone: "Asia/Shanghai",
      },
      new Date("2026-09-20T00:00:00.000Z"),
    );
    const runId = database.beginRun(job, job.nextRunAt!, new Date("2026-09-20T01:00:00.000Z"));
    assert.ok(runId);
    database.completeRun(runId, "delivered", null, new Date("2026-09-20T01:00:01.000Z"));

    assert.equal(database.listDueJobs(new Date("2026-09-20T01:01:00.000Z")).length, 1);
    assert.equal(database.beginRun(job, job.nextRunAt!, new Date("2026-09-20T01:01:00.000Z")), undefined);
    assert.equal(database.listDueJobs(new Date("2026-09-20T01:01:00.000Z")).length, 0);
  });
});

test("worker retries a notification and advances the job exactly once", async () => {
  await withDatabaseAsync(async (database, root) => {
    const createdAt = new Date("2026-09-20T00:00:00.000Z");
    const job = database.createReminder(
      {
        title: "实验室例会",
        schedule: { kind: "once", at: "2026-09-20T01:00:00.000Z" },
        timezone: "Asia/Shanghai",
      },
      createdAt,
    );
    let attempts = 0;
    const delivered: Array<{ title: string; action: NotificationAction | undefined }> = [];
    await processDueJobs(
      {
        paths: {
          root,
          config: join(root, "config.json"),
          database: join(root, "test.db"),
          secrets: join(root, "secrets.dpapi"),
          log: join(root, "worker.log"),
        },
        config: {
          timezone: "Asia/Shanghai",
          briefingTime: "07:30",
          thinkingLevel: "low",
          knowledgeVaultPath: join(root, "vault"),
          knowledgeDigestTime: "22:30",
        },
        database,
        logger: () => undefined,
      },
      {
        now: new Date("2026-09-20T01:00:00.000Z"),
        notifier: async (title, _body, action) => {
          attempts += 1;
          if (attempts < 4) throw new Error("temporary failure");
          delivered.push({ title, action });
        },
        sleep: async () => undefined,
      },
    );
    assert.equal(attempts, 4);
    assert.deepEqual(delivered, [{ title: "实验室例会", action: { kind: "today" } }]);
    assert.equal(database.runCount(job.id), 1);
    assert.equal(database.listDueJobs(new Date("2026-09-21T00:00:00.000Z")).length, 0);
  });
});

test("boot after 07:30 immediately sends a missed briefing and does not repeat it", async () => {
  await withDatabaseAsync(async (database, root) => {
    const config = {
      timezone: "Asia/Shanghai",
      briefingTime: "07:30",
      thinkingLevel: "low" as const,
      knowledgeVaultPath: join(root, "vault"),
      knowledgeDigestTime: "22:30",
    };
    const bootedAt = new Date("2026-09-20T00:00:00.000Z"); // 08:00 local
    database.ensureDailyBriefing(config, bootedAt);
    assert.equal(database.scheduleMissedDailyBriefing(config, bootedAt), true);
    assert.equal(database.listDueJobs(bootedAt).length, 1);

    const delivered: string[] = [];
    let briefingAttempts = 0;
    const delays: number[] = [];
    await processDueJobs(
      {
        paths: {
          root,
          config: join(root, "config.json"),
          database: join(root, "test.db"),
          secrets: join(root, "secrets.dpapi"),
          log: join(root, "worker.log"),
        },
        config,
        database,
        logger: () => undefined,
      },
      {
        now: bootedAt,
        briefingGenerator: async () => {
          briefingAttempts += 1;
          if (briefingAttempts === 1) throw new Error("Connection error.");
          return "测试简报";
        },
        notifier: async (_title, body) => {
          delivered.push(body);
        },
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
      },
    );
    assert.equal(briefingAttempts, 2);
    assert.deepEqual(delays, [60_000]);
    assert.deepEqual(delivered, ["测试简报"]);
    assert.equal(database.scheduleMissedDailyBriefing(config, new Date("2026-09-20T01:00:00.000Z")), false);
  });
});

function withDatabase(operation: (database: AppDatabase) => void): void {
  const root = mkdtempSync(join(tmpdir(), "person-agent-test-"));
  const database = new AppDatabase(join(root, "test.db"));
  try {
    operation(database);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function withDatabaseAsync(operation: (database: AppDatabase, root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "person-agent-test-"));
  const database = new AppDatabase(join(root, "test.db"));
  try {
    await operation(database, root);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}
