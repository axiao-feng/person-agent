import type { ResearchTask, ResearchTaskStatus, TaskKind } from "../../database.js";
import { applyTaskCommand, editTask, TaskTransitionError } from "../../domain/tasks.js";
import type { CalendarEvent } from "../../integrations/google.js";
import { findFreeSlots, parseInstant, type BusyInterval } from "../../schedule.js";
import { TASK_SCHEDULE_WORKFLOW, createWorkflowRegistry } from "../../workflows/registry.js";
import { createWorkflowRuntime } from "../../workflows/runtime.js";
import { approvalDto } from "../approval-data.js";
import type { Route, RouteRequest } from "../context.js";
import { ApiError, NotConfiguredError, safeErrorMessage } from "../errors.js";
import {
  enumField,
  integerQuery,
  notFound,
  objectBody,
  optionalInstantField,
  optionalIntegerField,
  requiredInstantQuery,
  requiredString,
  validation,
} from "../http.js";

const TASK_STATUSES: readonly ResearchTaskStatus[] = [
  "draft",
  "planned",
  "in_progress",
  "needs_replan",
  "completed",
  "cancelled",
];
const TASK_KINDS: readonly TaskKind[] = ["research", "assignment", "other"];
const PRIORITIES = ["low", "medium", "high"] as const;

export const taskRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/tasks",
    async handler(request) {
      const statusText = request.query.get("status");
      let status: ResearchTaskStatus | undefined;
      if (statusText) {
        if (!TASK_STATUSES.includes(statusText as ResearchTaskStatus)) {
          throw validation("任务状态无效。", "status", "任务状态无效。");
        }
        status = statusText as ResearchTaskStatus;
      }
      return { body: { items: request.database.listResearchTasks(status) } };
    },
  },
  {
    method: "POST",
    pattern: "/api/tasks",
    async handler(request) {
      const body = objectBody(request.body);
      const title = requiredString(body, "title", "任务标题");
      const taskKind = enumField(body, "taskKind", "任务分类", TASK_KINDS) ?? "research";
      const estimatedMinutes = optionalIntegerField(body, "estimatedMinutes", "预计耗时", 5, 1_440);
      if (estimatedMinutes === undefined) {
        throw validation("预计耗时不能为空。", "estimatedMinutes", "预计耗时不能为空。");
      }
      const deadline = optionalInstantField(body, "deadline", "截止时间");
      const priority = enumField(body, "priority", "优先级", PRIORITIES) ?? "medium";
      try {
        const task = request.database.createResearchTask(
          {
            title,
            taskKind,
            estimatedMinutes,
            priority,
            ...(deadline ? { deadline } : {}),
          },
          request.now,
        );
        return { status: 201, body: { task } };
      } catch (error) {
        throw validation(errorMessage(error));
      }
    },
  },
  {
    method: "PATCH",
    pattern: "/api/tasks/:taskId",
    async handler(request) {
      const taskId = requiredParam(request, "taskId");
      const body = objectBody(request.body);
      const operation = body.operation;
      if (typeof operation !== "string") {
        throw validation("缺少 operation。", "operation", "缺少 operation。");
      }
      try {
        if (operation === "edit") {
          const title = "title" in body ? requiredString(body, "title", "任务标题") : undefined;
          const taskKind = enumField(body, "taskKind", "任务分类", TASK_KINDS);
          const deadline = optionalInstantField(body, "deadline", "截止时间");
          const estimatedMinutes = optionalIntegerField(body, "estimatedMinutes", "预计耗时", 5, 1_440);
          const priority = enumField(body, "priority", "优先级", PRIORITIES);
          const task = editTask(
            request.database,
            taskId,
            {
              ...(title === undefined ? {} : { title }),
              ...(taskKind === undefined ? {} : { taskKind }),
              ...(deadline === undefined ? {} : { deadline }),
              ...(estimatedMinutes === undefined ? {} : { estimatedMinutes }),
              ...(priority === undefined ? {} : { priority }),
            },
            request.now,
          );
          return { body: { task } };
        }
        if (operation === "start" || operation === "complete" || operation === "cancel") {
          const task = applyTaskCommand(request.database, taskId, operation, request.now);
          return { body: { task } };
        }
        throw validation("operation 无效。", "operation", "operation 无效。");
      } catch (error) {
        throw translateTaskError(error);
      }
    },
  },
  {
    method: "GET",
    pattern: "/api/tasks/:taskId/candidate-slots",
    async handler(request) {
      const taskId = requiredParam(request, "taskId");
      const task = requireTask(request, taskId);
      if (task.status === "completed" || task.status === "cancelled") {
        throw new ApiError(409, "CONFLICT", "已完成或已取消的任务不需要安排时间。");
      }
      const start = requiredInstantQuery(request.query, "start");
      const end = requiredInstantQuery(request.query, "end");
      if (end <= start) throw validation("结束时间必须晚于开始时间。", "end", "结束时间必须晚于开始时间。");
      const limit = integerQuery(request.query, "limit", 5, 1, 20);
      let events: CalendarEvent[];
      try {
        events = await request.services.calendar.list(start, end, AbortSignal.timeout(15_000));
      } catch (error) {
        if (error instanceof NotConfiguredError) {
          throw new ApiError(503, "DEPENDENCY_UNAVAILABLE", "Google Calendar 尚未连接，无法计算候选时段。", true);
        }
        throw new ApiError(503, "DEPENDENCY_UNAVAILABLE", "Google Calendar 暂时不可用，无法计算候选时段。", true);
      }
      const busy: BusyInterval[] = events
        .filter((event) => event.status !== "cancelled" && !event.allDay)
        .map((event) => ({ start: event.start, end: event.end }));
      busy.push(
        ...request.database
          .listLectures(start, end)
          .filter((lecture) => lecture.endAt)
          .map((lecture) => ({ start: lecture.startAt, end: lecture.endAt! })),
        ...request.database
          .listResearchTasks()
          .filter((item) => item.plannedStart && item.plannedEnd && !item.calendarEventId)
          .map((item) => ({ start: item.plannedStart!, end: item.plannedEnd! })),
      );
      const slots = findFreeSlots({
        start: start.toISOString(),
        end: end.toISOString(),
        durationMinutes: task.estimatedMinutes,
        timezone: request.runtime.config.timezone,
        busy,
        limit,
      }).map((slot) => ({
        startAt: slot.start,
        endAt: slot.end,
        availableMinutes: slot.availableMinutes,
      }));
      return { body: { taskId: task.id, slots } };
    },
  },
  {
    method: "POST",
    pattern: "/api/tasks/:taskId/schedule",
    async handler(request) {
      const taskId = requiredParam(request, "taskId");
      const task = requireTask(request, taskId);
      if (task.status !== "draft" && task.status !== "needs_replan") {
        throw new ApiError(409, "CONFLICT", "只有待安排或需重排的任务可以生成新的日历安排。");
      }
      const body = objectBody(request.body);
      const startText = requiredString(body, "startAt", "开始时间", 100);
      const endText = requiredString(body, "endAt", "结束时间", 100);
      let startAt: string;
      let endAt: string;
      try {
        startAt = parseInstant(startText).toISOString();
        endAt = parseInstant(endText).toISOString();
      } catch {
        throw validation("开始和结束时间必须包含时区偏移。", "startAt", "开始和结束时间必须包含时区偏移。");
      }
      if (Date.parse(endAt) <= Date.parse(startAt)) {
        throw validation("结束时间必须晚于开始时间。", "endAt", "结束时间必须晚于开始时间。");
      }

      // The approval is staged by a durable workflow run so the state survives a
      // service restart between "schedule requested" and "still waiting for approval".
      const runtime = createWorkflowRuntime({
        database: request.database,
        registry: createWorkflowRegistry(),
      });
      const created = runtime.create({
        kind: TASK_SCHEDULE_WORKFLOW,
        input: { taskId, startAt, endAt },
      });
      const advanced = await runtime.advance(created.id, request.now);
      if (advanced.status === "failed") {
        throw new ApiError(409, "CONFLICT", advanced.error ?? "无法生成日历安排。");
      }
      const approvalId =
        typeof advanced.state.approvalId === "string" ? advanced.state.approvalId : undefined;
      const action = approvalId ? request.database.getWorkflowAction(approvalId) : undefined;
      if (!action) throw new ApiError(500, "INTERNAL_ERROR", "无法生成审批内容。");
      const approval = approvalDto(action, task);
      if (!approval) throw new ApiError(500, "INTERNAL_ERROR", "无法生成审批内容。");
      return { status: 201, body: { approval, workflowRunId: advanced.id } };
    },
  },
];

function requireTask(request: RouteRequest, id: string): ResearchTask {
  const task = request.database.getResearchTask(id);
  if (!task) throw notFound("找不到科研任务。");
  return task;
}

function requiredParam(request: RouteRequest, name: string): string {
  const value = request.params[name];
  if (!value) throw validation(`缺少 ${name} 参数。`, name, `缺少 ${name} 参数。`);
  return value;
}

function translateTaskError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof TaskTransitionError) {
    return error.message.startsWith("找不到")
      ? notFound(error.message)
      : new ApiError(409, "CONFLICT", error.message);
  }
  return validation(errorMessage(error));
}

function errorMessage(error: unknown): string {
  return safeErrorMessage(error, "任务操作失败。");
}
