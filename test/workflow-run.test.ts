import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeStoredApproval, type ApprovalExecutor } from "../src/calendar-actions.js";
import { AppDatabase } from "../src/database.js";
import type { CalendarEvent } from "../src/integrations/google.js";
import { TASK_SCHEDULE_WORKFLOW, createWorkflowRegistry } from "../src/workflows/registry.js";
import { advanceRun, resumePendingRuns, resumeRunsForApproval } from "../src/workflows/runtime.js";

const NOW = new Date("2026-11-04T02:00:00.000Z");
const START = "2026-11-05T01:00:00.000Z";
const END = "2026-11-05T02:00:00.000Z";

test("a schedule run waits for approval and finishes after the calendar write", async () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-workflow-run-test-"));
  const database = new AppDatabase(join(root, "test.db"));
  const registry = createWorkflowRegistry();
  try {
    const task = database.createResearchTask({ title: "整理实验结果", estimatedMinutes: 60 }, NOW);
    const run = database.createWorkflowRun(
      { kind: TASK_SCHEDULE_WORKFLOW, input: { taskId: task.id, startAt: START, endAt: END } },
      NOW,
    );

    const waiting = await advanceRun({ database, registry }, run.id, NOW);
    assert.equal(waiting.status, "waiting_for_user");
    assert.equal(waiting.currentStep, 1, "the staging step completed and the run now waits");
    const approvalId = String(waiting.state.approvalId);
    assert.ok(approvalId);
    assert.equal(database.getWorkflowAction(approvalId)?.status, "pending");
    assert.equal(database.getResearchTask(task.id)?.status, "draft", "no calendar write before approval");

    // Resuming while the approval is still pending keeps the run waiting without duplicating work.
    const stillWaiting = await advanceRun({ database, registry }, run.id, NOW);
    assert.equal(stillWaiting.status, "waiting_for_user");
    assert.equal(database.listWorkflowActions().length, 1);
    const pendingSteps = database.listWorkflowSteps(run.id);
    assert.deepEqual(pendingSteps.map((step) => step.status), ["succeeded", "pending"]);

    const executor: ApprovalExecutor = {
      async create(input) {
        return eventWith("created-event", input.title, input.startAt, input.endAt);
      },
      async update(id, input) {
        return eventWith(id, input.title, input.startAt, input.endAt);
      },
    };
    await executeStoredApproval({ database, actionId: approvalId, executor, now: NOW });
    assert.equal(database.getResearchTask(task.id)?.status, "planned");

    const advanced = await resumeRunsForApproval({ database, registry }, approvalId, NOW);
    assert.equal(advanced.length, 1);
    assert.equal(advanced[0]?.status, "succeeded");
    assert.equal(advanced[0]?.completedAt !== null, true);
    const steps = database.listWorkflowSteps(run.id);
    assert.deepEqual(steps.map((step) => step.status), ["succeeded", "succeeded"]);
    assert.deepEqual(steps.map((step) => step.kind), ["stage_approval", "await_approval"]);
    assert.match(JSON.stringify(steps[1]?.output), /created-event/);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rejected approval cancels the run and an unknown kind fails fast", async () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-workflow-run-test-"));
  const database = new AppDatabase(join(root, "test.db"));
  const registry = createWorkflowRegistry();
  try {
    const task = database.createResearchTask({ title: "写周报", estimatedMinutes: 30 }, NOW);
    const run = database.createWorkflowRun(
      { kind: TASK_SCHEDULE_WORKFLOW, input: { taskId: task.id, startAt: START, endAt: END } },
      NOW,
    );
    const waiting = await advanceRun({ database, registry }, run.id, NOW);
    database.rejectWorkflowAction(String(waiting.state.approvalId));

    const cancelled = await advanceRun({ database, registry }, run.id, NOW);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(database.getResearchTask(task.id)?.status, "draft");

    const unknown = database.createWorkflowRun(
      { kind: "task.unknown", input: {} },
      NOW,
    );
    const failed = await advanceRun({ database, registry }, unknown.id, NOW);
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /未注册的 workflow 类型/);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a waiting run resumes after a process restart and stale running runs are recovered", async () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-workflow-run-test-"));
  const path = join(root, "test.db");
  const registry = createWorkflowRegistry();
  let database = new AppDatabase(path);
  let runId = "";
  let approvalId = "";
  try {
    const task = database.createResearchTask({ title: "答辩准备", estimatedMinutes: 90 }, NOW);
    const run = database.createWorkflowRun(
      { kind: TASK_SCHEDULE_WORKFLOW, input: { taskId: task.id, startAt: START, endAt: END } },
      NOW,
    );
    runId = run.id;
    approvalId = String((await advanceRun({ database, registry }, run.id, NOW)).state.approvalId);
  } finally {
    database.close();
  }

  database = new AppDatabase(path);
  try {
    // The approval was executed while the service was down.
    await executeStoredApproval({
      database,
      actionId: approvalId,
      executor: {
        async create(input) {
          return eventWith("restart-event", input.title, input.startAt, input.endAt);
        },
        async update(id, input) {
          return eventWith(id, input.title, input.startAt, input.endAt);
        },
      },
      now: NOW,
    });

    const resumed = await resumePendingRuns({ database, registry }, { now: NOW });
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0]?.id, runId);
    assert.equal(resumed[0]?.status, "succeeded");

    // A run left in `running` by a crashed executor is re-claimed after the stale window.
    const staleRun = database.createWorkflowRun(
      { kind: TASK_SCHEDULE_WORKFLOW, input: { taskId: "missing-task", startAt: START, endAt: END } },
      NOW,
    );
    database.sqlite
      .prepare("UPDATE workflow_runs SET status = 'running', updated_at = ? WHERE id = ?")
      .run(new Date(NOW.getTime() - 30 * 60_000).toISOString(), staleRun.id);
    const stale = await resumePendingRuns({ database, registry }, { now: NOW });
    const recovered = stale.find((run) => run.id === staleRun.id);
    assert.ok(recovered, "the stale run is picked up again");
    assert.equal(recovered.status, "failed");
    assert.match(recovered.error ?? "", /找不到科研任务/);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run can be cancelled before the user approves", async () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-workflow-run-test-"));
  const database = new AppDatabase(join(root, "test.db"));
  const registry = createWorkflowRegistry();
  try {
    const task = database.createResearchTask({ title: "取消测试", estimatedMinutes: 30 }, NOW);
    const run = database.createWorkflowRun(
      { kind: TASK_SCHEDULE_WORKFLOW, input: { taskId: task.id, startAt: START, endAt: END } },
      NOW,
    );
    await advanceRun({ database, registry }, run.id, NOW);
    const cancelled = database.cancelWorkflowRun(run.id, NOW);
    assert.equal(cancelled.status, "cancelled");
    const again = await advanceRun({ database, registry }, run.id, NOW);
    assert.equal(again.status, "cancelled", "terminal runs are never re-executed");
    assert.equal(database.listWorkflowSteps(run.id).length, 1);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function eventWith(id: string, title: string, start: string, end: string): CalendarEvent {
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
