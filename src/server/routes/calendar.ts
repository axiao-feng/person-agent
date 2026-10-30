import type { ResearchTask } from "../../database.js";
import type { CalendarEvent } from "../../integrations/google.js";
import { localDateRange } from "../../schedule.js";
import { approvalDto } from "../approval-data.js";
import type { Route } from "../context.js";
import { NotConfiguredError, safeErrorMessage } from "../errors.js";
import { requiredInstantQuery, validation } from "../http.js";
import type { CalendarItem, SourceStatus } from "../types.js";

export const calendarRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/calendar",
    async handler(request) {
      const start = requiredInstantQuery(request.query, "start");
      const end = requiredInstantQuery(request.query, "end");
      if (end <= start) throw validation("结束时间必须晚于开始时间。", "end", "结束时间必须晚于开始时间。");
      if (end.getTime() - start.getTime() > 62 * 24 * 60 * 60_000) {
        throw validation("日历查询范围不能超过 62 天。", "end", "日历查询范围不能超过 62 天。");
      }
      const timezone = request.runtime.config.timezone;
      let events: CalendarEvent[] = [];
      let calendarStatus: SourceStatus;
      try {
        events = await request.services.calendar.list(start, end, AbortSignal.timeout(15_000));
        calendarStatus = { state: "available", updatedAt: request.now.toISOString(), message: null };
      } catch (error) {
        if (error instanceof NotConfiguredError) {
          calendarStatus = { state: "not_configured", updatedAt: null, message: safeErrorMessage(error) };
        } else {
          calendarStatus = { state: "unavailable", updatedAt: null, message: safeErrorMessage(error) };
        }
      }

      const tasks = request.database.listResearchTasks();
      const lectures = request.database.listLectures(start, end);
      const approvals = request.database
        .listWorkflowActions("pending")
        .map((action) => {
          const taskId = typeof action.payload.taskId === "string" ? action.payload.taskId : undefined;
          return approvalDto(action, taskId ? request.database.getResearchTask(taskId) : undefined);
        })
        .filter((approval): approval is NonNullable<typeof approval> => Boolean(approval));

      const items: CalendarItem[] = [];
      const plannedTasks = tasks.filter(
        (task) =>
          (task.status === "planned" || task.status === "in_progress") &&
          task.plannedStart !== null &&
          task.plannedEnd !== null &&
          Date.parse(task.plannedEnd) > start.getTime() &&
          Date.parse(task.plannedStart) < end.getTime(),
      );
      const taskByEventId = new Map<string, ResearchTask>();
      for (const task of plannedTasks) {
        if (task.calendarEventId) taskByEventId.set(task.calendarEventId, task);
      }

      const includedEventIds = new Set<string>();
      for (const event of events) {
        if (event.status === "cancelled") continue;
        const times = eventTimes(event, timezone);
        if (!times) continue;
        includedEventIds.add(event.id);
        const linkedTask = taskByEventId.get(event.id);
        items.push({
          id: `google:${event.id}`,
          source: "google",
          title: event.title,
          startAt: times.startAt,
          endAt: times.endAt ?? times.startAt,
          allDay: event.allDay,
          status: event.status,
          conflict: linkedTask?.status === "needs_replan",
          linkedObjectId: linkedTask?.id ?? null,
        });
      }

      for (const task of plannedTasks) {
        if (task.calendarEventId && includedEventIds.has(task.calendarEventId)) continue;
        items.push({
          id: `task:${task.id}`,
          source: "task",
          title: task.title,
          startAt: task.plannedStart!,
          endAt: task.plannedEnd!,
          allDay: false,
          status: task.status,
          conflict: task.status === "needs_replan",
          linkedObjectId: task.id,
        });
      }

      for (const lecture of lectures) {
        items.push({
          id: `lecture:${lecture.id}`,
          source: "lecture",
          title: lecture.title,
          startAt: lecture.startAt,
          endAt: lecture.endAt ?? lecture.startAt,
          allDay: false,
          status: lecture.status,
          conflict: false,
          linkedObjectId: lecture.id,
        });
      }

      for (const approval of approvals) {
        const startAt = approval.display.proposedStart;
        const endAt = approval.display.proposedEnd;
        if (Date.parse(endAt) <= start.getTime() || Date.parse(startAt) >= end.getTime()) continue;
        items.push({
          id: `approval:${approval.id}`,
          source: "approval",
          title: approval.display.title,
          startAt,
          endAt,
          allDay: false,
          status: approval.status,
          conflict: false,
          linkedObjectId: approval.id,
        });
      }

      items.sort(
        (left, right) =>
          Number(right.allDay) - Number(left.allDay) ||
          left.startAt.localeCompare(right.startAt) ||
          left.title.localeCompare(right.title),
      );

      return {
        body: {
          status: calendarStatus.state === "unavailable" ? "partial" : "success",
          sources: {
            calendar: calendarStatus,
            lectures: localStatus(),
            tasks: localStatus(),
            approvals: localStatus(),
          },
          items,
        },
      };
    },
  },
];

function eventTimes(
  event: CalendarEvent,
  timezone: string,
): { startAt: string; endAt: string | null } | undefined {
  if (event.allDay) {
    let startAt: string;
    try {
      startAt = localDateRange(event.start, timezone).start.toISOString();
    } catch {
      return undefined;
    }
    let endAt: string | null = null;
    try {
      endAt = localDateRange(event.end, timezone).start.toISOString();
    } catch {
      endAt = null;
    }
    return { startAt, endAt };
  }
  const start = Date.parse(event.start);
  if (Number.isNaN(start)) return undefined;
  const end = Date.parse(event.end);
  return {
    startAt: new Date(start).toISOString(),
    endAt: Number.isNaN(end) ? null : new Date(end).toISOString(),
  };
}

function localStatus(): SourceStatus {
  return { state: "available", updatedAt: null, message: null };
}
