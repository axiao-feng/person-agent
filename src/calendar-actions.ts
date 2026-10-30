import { AppDatabase, type WorkflowAction } from "./database.js";
import {
  GoogleService,
  type CalendarEvent,
  type CalendarEventInput,
} from "./integrations/google.js";
import type { AppPaths } from "./paths.js";

export class WorkflowActionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "WorkflowActionError";
  }
}

export type ApprovalExecutor = {
  create(input: CalendarEventInput, idempotencyId: string): Promise<CalendarEvent>;
  update(eventId: string, input: CalendarEventInput): Promise<CalendarEvent>;
};

export function defaultApprovalExecutor(paths: AppPaths): ApprovalExecutor {
  return {
    async create(input, idempotencyId) {
      const google = await GoogleService.create(paths);
      return await google.createCalendarEvent(input, idempotencyId);
    },
    async update(eventId, input) {
      const google = await GoogleService.create(paths);
      return await google.updateCalendarEvent(eventId, input);
    },
  };
}

/**
 * Executes only the persisted payload. The client cannot submit new times or
 * titles at approval time; a mismatch is rejected by claimWorkflowAction.
 */
export async function executeStoredApproval(options: {
  database: AppDatabase;
  actionId: string;
  executor: ApprovalExecutor;
  now?: Date;
}): Promise<WorkflowAction> {
  const now = options.now ?? new Date();
  const action = options.database.getWorkflowAction(options.actionId);
  if (!action) throw new WorkflowActionError("找不到待审批操作。", 404);
  if (action.status === "rejected") {
    throw new WorkflowActionError("该操作已被拒绝，不能再执行。", 409);
  }
  if (action.status === "executing") {
    throw new WorkflowActionError("该操作正在执行，请稍后刷新。", 409);
  }
  if (action.status === "executed") return action;

  let approved: WorkflowAction;
  let claimed: WorkflowAction;
  try {
    approved = options.database.approveWorkflowAction(action.id, now);
    claimed = options.database.claimWorkflowAction(action.id, approved.kind, approved.payload);
  } catch (error) {
    throw new WorkflowActionError(safeError(error), 409);
  }

  try {
    const input = calendarEventInput(claimed.payload);
    const event =
      claimed.kind === "calendar.create"
        ? await options.executor.create(input, claimed.id)
        : await options.executor.update(requiredEventId(claimed.payload), input);
    linkTaskToCalendar(
      options.database,
      optionalString(claimed.payload.taskId),
      event.id,
      input.startAt,
      input.endAt,
      now,
    );
    return options.database.completeWorkflowAction(claimed.id, event, now);
  } catch (error) {
    return options.database.failWorkflowAction(claimed.id, safeError(error));
  }
}

export function linkTaskToCalendar(
  database: AppDatabase,
  taskId: string | undefined,
  calendarEventId: string,
  startAt: string,
  endAt: string,
  now = new Date(),
): void {
  if (!taskId) return;
  database.updateResearchTask(
    taskId,
    {
      status: "planned",
      plannedStart: startAt,
      plannedEnd: endAt,
      calendarEventId,
    },
    now,
  );
}

export function calendarEventInput(payload: Record<string, unknown>): CalendarEventInput {
  const title = requiredString(payload.title, "标题");
  const startAt = requiredString(payload.startAt, "开始时间");
  const endAt = requiredString(payload.endAt, "结束时间");
  return {
    title,
    startAt,
    endAt,
    ...(optionalString(payload.description) ? { description: optionalString(payload.description)! } : {}),
    ...(optionalString(payload.location) ? { location: optionalString(payload.location)! } : {}),
  };
}

function requiredEventId(payload: Record<string, unknown>): string {
  const value = optionalString(payload.calendarEventId);
  if (!value) throw new Error("审批内容缺少关联的 Calendar 事件 ID。");
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`审批内容缺少${label}。`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "未知错误";
  return message.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]").slice(0, 1_000);
}
