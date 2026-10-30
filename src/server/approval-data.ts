import type { ResearchTask, WorkflowAction } from "../database.js";
import type { Approval } from "./types.js";

export function approvalDto(
  action: WorkflowAction,
  task: ResearchTask | undefined,
): Approval | undefined {
  const proposedStart = isoOrNull(action.payload.startAt);
  const proposedEnd = isoOrNull(action.payload.endAt);
  if (!proposedStart || !proposedEnd) return undefined;
  const title =
    typeof action.payload.title === "string" && action.payload.title.trim()
      ? action.payload.title.trim().slice(0, 200)
      : "（未命名日程）";
  let reason: string | null = null;
  if (task?.status === "needs_replan") {
    reason = "关联日历事件已取消、删除或发生时间冲突。";
  } else if (action.kind === "calendar.update") {
    reason = "调整已有日程安排。";
  }
  const originalStart =
    action.kind === "calendar.update" &&
    task?.plannedStart &&
    task.plannedStart !== proposedStart
      ? task.plannedStart
      : null;
  const originalEnd =
    action.kind === "calendar.update" &&
    task?.plannedEnd &&
    task.plannedEnd !== proposedEnd
      ? task.plannedEnd
      : null;
  return {
    id: action.id,
    kind: action.kind,
    status: action.status,
    display: {
      target: "Google Calendar",
      title,
      reason,
      originalStart,
      originalEnd,
      proposedStart,
      proposedEnd,
    },
    error: action.error,
    createdAt: action.createdAt,
    approvedAt: action.approvedAt,
    executedAt: action.executedAt,
  };
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}
