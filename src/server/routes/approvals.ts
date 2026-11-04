import { executeStoredApproval, WorkflowActionError } from "../../calendar-actions.js";
import type { WorkflowActionStatus } from "../../database.js";
import { createWorkflowRegistry } from "../../workflows/registry.js";
import { resumeRunsForApproval } from "../../workflows/runtime.js";
import { approvalDto } from "../approval-data.js";
import type { Route, RouteRequest } from "../context.js";
import { ApiError } from "../errors.js";
import { notFound, validation } from "../http.js";
import type { Approval } from "../types.js";

const STATUSES: readonly WorkflowActionStatus[] = [
  "pending",
  "approved",
  "executing",
  "executed",
  "failed",
  "rejected",
];

export const approvalRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/approvals",
    async handler(request) {
      const statusText = request.query.get("status");
      if (statusText && !STATUSES.includes(statusText as WorkflowActionStatus)) {
        throw validation("审批状态无效。", "status", "审批状态无效。");
      }
      const actions = request.database.listWorkflowActions(
        statusText ? (statusText as WorkflowActionStatus) : undefined,
      );
      return { body: { items: actions.map((action) => toApproval(request, action)).filter(Boolean) } };
    },
  },
  {
    method: "GET",
    pattern: "/api/approvals/history",
    async handler(request) {
      const limit = historyLimit(request.query.get("limit"));
      const actions = request.database.listApprovalHistory(limit);
      return { body: { items: actions.map((action) => toApproval(request, action)).filter(Boolean) } };
    },
  },
  {
    method: "POST",
    pattern: "/api/approvals/:actionId/approve",
    async handler(request) {
      const actionId = requiredActionId(request);
      try {
        const action = await executeStoredApproval({
          database: request.database,
          actionId,
          executor: request.services.approvalExecutor,
          now: request.now,
        });
        try {
          await resumeRunsForApproval(
            { database: request.database, registry: createWorkflowRegistry() },
            action.id,
            request.now,
          );
        } catch {
          // Workflow resumption is best-effort; the worker retries on its next tick.
        }
        return { body: { approval: requireApproval(request, action) } };
      } catch (error) {
        if (error instanceof WorkflowActionError) {
          throw new ApiError(
            error.status,
            error.status === 404 ? "NOT_FOUND" : "CONFLICT",
            error.message,
          );
        }
        throw error;
      }
    },
  },
  {
    method: "POST",
    pattern: "/api/approvals/:actionId/reject",
    async handler(request) {
      const actionId = requiredActionId(request);
      const action = request.database.getWorkflowAction(actionId);
      if (!action) throw notFound("找不到待审批操作。");
      if (action.status === "executed") {
        throw new ApiError(409, "CONFLICT", "已执行的操作不能拒绝。");
      }
      if (action.status === "executing") {
        throw new ApiError(409, "CONFLICT", "正在执行的操作不能拒绝。");
      }
      const rejected = request.database.rejectWorkflowAction(actionId);
      return { body: { approval: requireApproval(request, rejected) } };
    },
  },
];

function toApproval(
  request: RouteRequest,
  action: Parameters<typeof approvalDto>[0],
): Approval | undefined {
  const taskId = typeof action.payload.taskId === "string" ? action.payload.taskId : undefined;
  return approvalDto(action, taskId ? request.database.getResearchTask(taskId) : undefined);
}

function requireApproval(
  request: RouteRequest,
  action: Parameters<typeof approvalDto>[0],
): Approval {
  const approval = toApproval(request, action);
  if (!approval) throw new ApiError(500, "INTERNAL_ERROR", "无法生成审批内容。");
  return approval;
}

function requiredActionId(request: RouteRequest): string {
  const actionId = request.params.actionId;
  if (!actionId) throw validation("缺少 actionId 参数。", "actionId");
  return actionId;
}

function historyLimit(text: string | null): number {
  if (text === null) return 20;
  if (!/^\d+$/.test(text)) {
    throw validation("limit 必须是 1–50 的整数。", "limit", "limit 必须是 1–50 的整数。");
  }
  const limit = Number(text);
  if (limit < 1 || limit > 50) {
    throw validation("limit 必须是 1–50 的整数。", "limit", "limit 必须是 1–50 的整数。");
  }
  return limit;
}
