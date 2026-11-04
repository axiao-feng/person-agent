import { parseInstant } from "../schedule.js";
import type { WorkflowDefinition, WorkflowRegistry } from "./types.js";

export const TASK_SCHEDULE_WORKFLOW = "task.schedule";

/**
 * Pilot workflow: turns "put this task on the calendar" into a durable run.
 *
 * Step 1 stages a fixed-payload approval action; the run then waits for the user.
 * Step 2 inspects the persisted approval after resume, so a crash between the
 * click and the calendar write cannot lose the state or bypass the approval gate.
 */
const taskScheduleWorkflow: WorkflowDefinition = {
  kind: TASK_SCHEDULE_WORKFLOW,
  steps: [
    {
      kind: "stage_approval",
      execute({ database, run, now }) {
        const taskId = requiredString(run.input, "taskId");
        const startAt = instantField(run.input, "startAt");
        const endAt = instantField(run.input, "endAt");
        if (Date.parse(endAt) <= Date.parse(startAt)) {
          return { status: "failed", error: "结束时间必须晚于开始时间。" };
        }
        const task = database.getResearchTask(taskId);
        if (!task) return { status: "failed", error: "找不到科研任务。" };
        if (task.status === "planned" && task.calendarEventId) {
          return { status: "done", output: { taskId, calendarEventId: task.calendarEventId, alreadyPlanned: true } };
        }
        if (task.status !== "draft" && task.status !== "needs_replan") {
          return {
            status: "failed",
            error: "只有待安排或需重排的任务可以生成新的日历安排。",
          };
        }
        const kind = task.calendarEventId ? "calendar.update" : "calendar.create";
        const action = database.stageWorkflowAction(
          kind,
          {
            title: task.title,
            startAt,
            endAt,
            taskId: task.id,
            ...(task.calendarEventId ? { calendarEventId: task.calendarEventId } : {}),
          },
          now,
        );
        return {
          status: "waiting",
          output: { approvalId: action.id, kind: action.kind },
          state: { approvalId: action.id, taskId: task.id },
        };
      },
    },
    {
      kind: "await_approval",
      execute({ database, run }) {
        const approvalId = requiredString(run.state, "approvalId", "运行状态缺少 approvalId。");
        const action = database.getWorkflowAction(approvalId);
        if (!action) return { status: "failed", error: "找不到待审批操作。" };
        if (action.status === "executed") {
          return { status: "done", output: { approvalId, result: action.result } };
        }
        if (action.status === "rejected") return { status: "cancelled", output: { approvalId } };
        if (action.status === "failed") {
          return { status: "failed", error: action.error ?? "Calendar 写入失败。" };
        }
        return { status: "poll", state: run.state };
      },
    },
  ],
};

export function createWorkflowRegistry(): WorkflowRegistry {
  return new Map([[taskScheduleWorkflow.kind, taskScheduleWorkflow]]);
}

function requiredString(
  source: Record<string, unknown>,
  key: string,
  message = `workflow 输入缺少 ${key}。`,
): string {
  const value = source[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value.trim();
}

function instantField(source: Record<string, unknown>, key: string): string {
  const value = requiredString(source, key);
  try {
    return parseInstant(value).toISOString();
  } catch {
    throw new Error(`${key} 必须是带时区的有效时间。`);
  }
}
