import type { WorkflowRun, WorkflowStep } from "../../database.js";
import { createWorkflowRegistry } from "../../workflows/registry.js";
import { advanceRun, resumePendingRuns } from "../../workflows/runtime.js";
import type { Route, RouteRequest } from "../context.js";
import { ApiError } from "../errors.js";
import { integerQuery, notFound, validation } from "../http.js";
import type { WorkflowRunDto, WorkflowStepDto } from "../types.js";

const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_for_user",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const workflowRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/workflows",
    async handler(request) {
      const statusText = request.query.get("status");
      if (statusText && !RUN_STATUSES.includes(statusText as (typeof RUN_STATUSES)[number])) {
        throw validation("workflow 状态无效。", "status", "workflow 状态无效。");
      }
      const kind = request.query.get("kind")?.trim() || undefined;
      const limit = integerQuery(request.query, "limit", 20, 1, 100);
      const runs = request.database.listWorkflowRuns({
        ...(statusText ? { status: statusText as (typeof RUN_STATUSES)[number] } : {}),
        ...(kind ? { kind } : {}),
        limit,
      });
      return { body: { items: runs.map(runDto) } };
    },
  },
  {
    method: "GET",
    pattern: "/api/workflows/:runId",
    async handler(request) {
      const runId = requiredRunId(request);
      const run = request.database.getWorkflowRun(runId);
      if (!run) throw notFound("找不到该 workflow run。");
      return { body: { run: runDto(run), steps: request.database.listWorkflowSteps(runId).map(stepDto) } };
    },
  },
  {
    method: "POST",
    pattern: "/api/workflows/:runId/resume",
    async handler(request) {
      const runId = requiredRunId(request);
      const run = request.database.getWorkflowRun(runId);
      if (!run) throw notFound("找不到该 workflow run。");
      if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
        throw new ApiError(409, "CONFLICT", "已结束的 workflow 不能继续。");
      }
      const advanced = await advanceRun(
        { database: request.database, registry: createWorkflowRegistry() },
        runId,
        request.now,
      );
      return {
        body: {
          run: runDto(advanced),
          steps: request.database.listWorkflowSteps(runId).map(stepDto),
        },
      };
    },
  },
  {
    method: "POST",
    pattern: "/api/workflows/:runId/cancel",
    async handler(request) {
      const runId = requiredRunId(request);
      const run = request.database.getWorkflowRun(runId);
      if (!run) throw notFound("找不到该 workflow run。");
      const cancelled = request.database.cancelWorkflowRun(runId, request.now);
      return {
        body: {
          run: runDto(cancelled),
          steps: request.database.listWorkflowSteps(runId).map(stepDto),
        },
      };
    },
  },
  {
    method: "POST",
    pattern: "/api/workflows/resume-pending",
    async handler(request) {
      const advanced = await resumePendingRuns(
        { database: request.database, registry: createWorkflowRegistry() },
        { now: request.now, limit: 20 },
      );
      return { body: { items: advanced.map(runDto) } };
    },
  },
];

export function runDto(run: WorkflowRun): WorkflowRunDto {
  return {
    id: run.id,
    conversationId: run.conversationId,
    kind: run.kind,
    status: run.status,
    input: run.input,
    state: run.state,
    currentStep: run.currentStep,
    error: run.error,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  };
}

export function stepDto(step: WorkflowStep): WorkflowStepDto {
  return {
    id: step.id,
    sequence: step.sequence,
    kind: step.kind,
    status: step.status,
    input: step.input,
    output: step.output,
    error: step.error,
    idempotencyKey: step.idempotencyKey,
    startedAt: step.startedAt,
    completedAt: step.completedAt,
  };
}

function requiredRunId(request: RouteRequest): string {
  const runId = request.params.runId;
  if (!runId) throw validation("缺少 runId 参数。", "runId");
  return runId;
}
