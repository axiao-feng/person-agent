import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { AppConfig } from "../src/config.js";
import { AppDatabase, KNOWLEDGE_DIGEST_JOB_ID } from "../src/database.js";

test("old research_tasks rows migrate to the research category", () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-migration-test-"));
  const path = join(root, "old.db");
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE research_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'email')),
      source_id TEXT,
      deadline TEXT,
      estimated_minutes INTEGER NOT NULL CHECK (estimated_minutes BETWEEN 5 AND 1440),
      priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
      status TEXT NOT NULL CHECK (status IN ('draft', 'planned', 'in_progress', 'needs_replan', 'completed', 'cancelled')),
      confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
      planned_start TEXT,
      planned_end TEXT,
      calendar_event_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO research_tasks
      (id, title, source_type, source_id, deadline, estimated_minutes, priority, status,
       confidence, planned_start, planned_end, calendar_event_id, created_at, updated_at)
    VALUES
      ('legacy-1', '旧任务', 'manual', NULL, NULL, 60, 'medium', 'draft', 1,
       NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  raw.close();

  const database = new AppDatabase(path);
  try {
    assert.equal(database.listResearchTasks()[0]?.taskKind, "research");
    assert.equal(database.getResearchTask("legacy-1")?.title, "旧任务");
    const assignment = database.createResearchTask({
      title: "数值分析作业",
      taskKind: "assignment",
      estimatedMinutes: 90,
    });
    assert.equal(assignment.taskKind, "assignment");
    assert.equal(database.listResearchTasks()[1]?.taskKind, "assignment");
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge digest job schedules at 22:30 and can catch up after a missed run", () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-knowledge-job-test-"));
  const database = new AppDatabase(join(root, "test.db"));
  const config: AppConfig = {
    timezone: "Asia/Shanghai",
    briefingTime: "07:30",
    thinkingLevel: "low",
    knowledgeVaultPath: join(root, "vault"),
    knowledgeDigestTime: "22:30",
  };
  try {
    const evening = new Date("2026-10-29T10:00:00.000Z"); // 18:00 local
    database.ensureKnowledgeDigest(config, evening);
    const row = database.sqlite
      .prepare("SELECT next_run_at, catchup_minutes, kind FROM jobs WHERE id = ?")
      .get(KNOWLEDGE_DIGEST_JOB_ID) as { next_run_at: string; catchup_minutes: number; kind: string };
    assert.equal(row.kind, "briefing");
    assert.equal(row.next_run_at, "2026-10-29T14:30:00.000Z");
    assert.equal(row.catchup_minutes, 10080);

    const late = new Date("2026-10-29T15:00:00.000Z"); // 23:00 local
    assert.equal(database.scheduleMissedKnowledgeDigest(config, late), true);
    const due = database.listDueJobs(late);
    assert.equal(due.length, 1);
    assert.equal(due[0]?.id, KNOWLEDGE_DIGEST_JOB_ID);

    const job = due[0]!;
    const runId = database.beginRun(job, job.nextRunAt!, late);
    assert.ok(runId);
    database.completeRun(runId, "delivered", null, late);
    database.advanceJob(job, job.nextRunAt!, late);
    assert.equal(database.scheduleMissedKnowledgeDigest(config, new Date("2026-10-29T15:05:00.000Z")), false);
    assert.equal(database.listDueJobs(new Date("2026-10-29T15:05:00.000Z")).length, 0);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed catch-up waits an hour before re-entering the backlog", () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-knowledge-job-test-"));
  const database = new AppDatabase(join(root, "test.db"));
  const config: AppConfig = {
    timezone: "Asia/Shanghai",
    briefingTime: "07:30",
    thinkingLevel: "low",
    knowledgeVaultPath: join(root, "vault"),
    knowledgeDigestTime: "22:30",
  };
  try {
    database.ensureKnowledgeDigest(config, new Date("2026-10-29T10:00:00.000Z")); // 18:00 local
    const failedAt = new Date("2026-10-29T15:00:00.000Z"); // 23:00 local
    assert.equal(database.scheduleMissedKnowledgeDigest(config, failedAt), true);
    const [job] = database.listDueJobs(failedAt);
    assert.ok(job);
    const runId = database.beginRun(job, job.nextRunAt!, failedAt);
    assert.ok(runId);
    database.completeRun(runId, "failed", "model unavailable", failedAt);
    database.advanceJob(job, job.nextRunAt!, failedAt);
    assert.equal(
      database.scheduleMissedKnowledgeDigest(config, new Date("2026-10-29T15:30:00.000Z")),
      false,
    );
    assert.equal(
      database.scheduleMissedKnowledgeDigest(config, new Date("2026-10-29T16:30:00.000Z")),
      true,
    );
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missed 22:30 digest is recovered on the next morning within the catch-up window", () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-knowledge-job-test-"));
  const database = new AppDatabase(join(root, "test.db"));
  const config: AppConfig = {
    timezone: "Asia/Shanghai",
    briefingTime: "07:30",
    thinkingLevel: "low",
    knowledgeVaultPath: join(root, "vault"),
    knowledgeDigestTime: "22:30",
  };
  try {
    database.ensureKnowledgeDigest(config, new Date("2026-10-29T10:00:00.000Z")); // 18:00 local Oct 29
    const lateMorning = new Date("2026-10-30T03:00:00.000Z"); // 11:00 local Oct 30, 12.5h late
    assert.equal(database.scheduleMissedKnowledgeDigest(config, lateMorning), true);
    const [job] = database.listDueJobs(lateMorning);
    assert.ok(job);
    assert.equal(job.nextRunAt, "2026-10-29T14:30:00.000Z");
    const runId = database.beginRun(job, job.nextRunAt!, lateMorning);
    assert.ok(runId);
    database.completeRun(runId, "delivered", null, lateMorning);
    database.advanceJob(job, job.nextRunAt!, lateMorning);
    const row = database.sqlite
      .prepare("SELECT next_run_at FROM jobs WHERE id = ?")
      .get(KNOWLEDGE_DIGEST_JOB_ID) as { next_run_at: string };
    assert.equal(row.next_run_at, "2026-10-30T14:30:00.000Z");
    assert.equal(
      database.scheduleMissedKnowledgeDigest(config, new Date(lateMorning.getTime() + 60_000)),
      false,
    );
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
