import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AppDatabase } from "../src/database.js";
import type { CalendarEvent } from "../src/integrations/google.js";
import { findFreeSlots } from "../src/schedule.js";
import { buildTools } from "../src/tools.js";
import { monitorTaskPlans } from "../src/worker.js";

test("finds deterministic work-hour gaps in the configured timezone", () => {
  const slots = findFreeSlots({
    start: "2026-09-21T00:00:00+08:00",
    end: "2026-09-22T00:00:00+08:00",
    durationMinutes: 60,
    timezone: "Asia/Shanghai",
    busy: [{ start: "2026-09-21T10:00:00+08:00", end: "2026-09-21T11:00:00+08:00" }],
  });
  assert.deepEqual(slots, [
    { start: "2026-09-21T01:00:00.000Z", end: "2026-09-21T02:00:00.000Z", availableMinutes: 60 },
    { start: "2026-09-21T03:00:00.000Z", end: "2026-09-21T10:00:00.000Z", availableMinutes: 420 },
  ]);
});

test("persists research tasks and enforces approval before workflow execution", () => {
  withDatabase((database) => {
    assert.throws(
      () => database.createResearchTask({ title: "无来源", sourceType: "email" }),
      /Gmail message ID/,
    );
    const task = database.createResearchTask({
      title: "整理实验结果",
      sourceType: "email",
      sourceId: "gmail-1",
      deadline: "2026-09-25T18:00:00+08:00",
      estimatedMinutes: 90,
      confidence: 0.9,
    });
    assert.equal(task.status, "draft");
    assert.equal(database.listResearchTasks()[0]?.sourceId, "gmail-1");
    assert.throws(() => database.updateResearchTask(task.id, { status: "planned" }), /必须同时关联/);

    const payload = {
      title: task.title,
      startAt: "2026-09-22T01:00:00.000Z",
      endAt: "2026-09-22T02:30:00.000Z",
      taskId: task.id,
    };
    const action = database.stageWorkflowAction("calendar.create", payload);
    assert.throws(() => database.claimWorkflowAction(action.id, "calendar.create", payload), /尚未获批/);
    database.approveWorkflowAction(action.id);
    assert.throws(
      () => database.claimWorkflowAction(action.id, "calendar.create", { ...payload, title: "被篡改" }),
      /审批内容与待执行操作不一致/,
    );
    assert.equal(database.claimWorkflowAction(action.id, "calendar.create", payload).status, "executing");
    database.completeWorkflowAction(action.id, { id: "calendar-1" });
    assert.deepEqual(database.claimWorkflowAction(action.id, "calendar.create", payload).result, { id: "calendar-1" });
  });
});

test("calendar tool stages a durable action without touching Google before approval", async () => {
  await withDatabaseAsync(async (database, root) => {
    const tools = buildTools({
      paths: testPaths(root),
      config: {
        timezone: "Asia/Shanghai",
        briefingTime: "07:30",
        thinkingLevel: "low",
        knowledgeVaultPath: join(root, "vault"),
        knowledgeDigestTime: "22:30",
      },
      database,
    });
    const tool = tools.find((candidate) => candidate.name === "create_calendar_event");
    assert.ok(tool);
    const result = await tool.execute(
      "call-1",
      {
        title: "阅读论文",
        startAt: "2026-09-22T09:00:00+08:00",
        endAt: "2026-09-22T10:00:00+08:00",
      },
      new AbortController().signal,
      () => undefined,
    );
    assert.equal((result.details as { requiresApproval: boolean }).requiresApproval, true);
    assert.equal(database.listWorkflowActions("pending").length, 1);
  });
});

test("capture_idea writes an idea note without creating a task or calendar action", async () => {
  await withDatabaseAsync(async (database, root) => {
    const vault = join(root, "vault");
    const tools = buildTools({
      paths: testPaths(root),
      config: {
        timezone: "Asia/Shanghai",
        briefingTime: "07:30",
        thinkingLevel: "low",
        knowledgeVaultPath: vault,
        knowledgeDigestTime: "22:30",
      },
      database,
    });
    const tool = tools.find((candidate) => candidate.name === "capture_idea");
    assert.ok(tool);
    const result = await tool.execute(
      "call-idea",
      { body: "用消融实验验证检索质量。\n第二行", tags: ["实验"] },
      new AbortController().signal,
      () => undefined,
    );
    const path = (result.details as { path: string }).path;
    assert.ok(existsSync(path));
    assert.match(readFileSync(path, "utf8"), /用消融实验验证检索质量/);
    assert.equal(database.listResearchTasks().length, 0);
    assert.equal(database.listWorkflowActions().length, 0);
  });
});

test("approved workflow action survives a process restart", () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-recovery-test-"));
  const path = join(root, "test.db");
  const payload = {
    title: "恢复测试",
    startAt: "2026-09-22T01:00:00.000Z",
    endAt: "2026-09-22T02:00:00.000Z",
  };
  let database = new AppDatabase(path);
  const action = database.stageWorkflowAction("calendar.create", payload);
  database.approveWorkflowAction(action.id);
  database.close();
  database = new AppDatabase(path);
  try {
    assert.equal(database.claimWorkflowAction(action.id, "calendar.create", payload).status, "executing");
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("monitor detects a calendar conflict and stages a replan proposal", async () => {
  await withDatabaseAsync(async (database, root) => {
    const task = database.createResearchTask({
      title: "完成论文实验",
      deadline: "2026-09-23T18:00:00+08:00",
      estimatedMinutes: 60,
    });
    database.updateResearchTask(task.id, {
      status: "planned",
      plannedStart: "2026-09-21T10:00:00+08:00",
      plannedEnd: "2026-09-21T11:00:00+08:00",
      calendarEventId: "own-event",
    });
    const own = event("own-event", "完成论文实验", "2026-09-21T10:00:00+08:00", "2026-09-21T11:00:00+08:00");
    const conflict = event("meeting", "临时组会", "2026-09-21T10:30:00+08:00", "2026-09-21T11:30:00+08:00");
    const notifications: string[] = [];
    await monitorTaskPlans(
      {
        paths: testPaths(root),
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
        now: new Date("2026-09-21T00:00:00.000Z"),
        calendar: {
          getCalendarEvent: async () => own,
          listCalendarEvents: async () => [own, conflict],
        },
        notifier: async (_title, body) => {
          notifications.push(body);
        },
      },
    );
    assert.equal(database.getResearchTask(task.id)?.status, "needs_replan");
    const [action] = database.listWorkflowActions("pending");
    assert.equal(action?.kind, "calendar.update");
    assert.equal(action?.payload.taskId, task.id);
    assert.match(notifications[0]!, /\/approve/);
  });
});

test("briefing mode has no tools because data acquisition is a fixed workflow", () => {
  withDatabase((database, root) => {
    assert.deepEqual(
      buildTools(
        {
          paths: testPaths(root),
          config: {
            timezone: "Asia/Shanghai",
            briefingTime: "07:30",
            thinkingLevel: "low",
            knowledgeVaultPath: join(root, "vault"),
            knowledgeDigestTime: "22:30",
          },
          database,
        },
        "briefing",
      ),
      [],
    );
  });
});

function event(id: string, title: string, start: string, end: string): CalendarEvent {
  return {
    id,
    calendar: "primary",
    title,
    description: null,
    location: null,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    allDay: false,
    status: "confirmed",
    attendees: [],
  };
}

function testPaths(root: string) {
  return {
    root,
    config: join(root, "config.json"),
    database: join(root, "test.db"),
    secrets: join(root, "secrets.dpapi"),
    log: join(root, "worker.log"),
  };
}

function withDatabase(operation: (database: AppDatabase, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "person-agent-workflow-test-"));
  const database = new AppDatabase(join(root, "test.db"));
  try {
    operation(database, root);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function withDatabaseAsync(operation: (database: AppDatabase, root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "person-agent-workflow-test-"));
  const database = new AppDatabase(join(root, "test.db"));
  try {
    await operation(database, root);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}
