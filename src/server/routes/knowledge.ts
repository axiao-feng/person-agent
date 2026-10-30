import type { Operation, OperationKind } from "../../database.js";
import type { Route, RouteRequest } from "../context.js";
import { ApiError, safeErrorMessage } from "../errors.js";
import { notFound } from "../http.js";
import type { OperationDto } from "../types.js";

export const knowledgeRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/api/knowledge/sync",
    handler: async (request) => startOperation(request, "knowledge.sync"),
  },
  {
    method: "POST",
    pattern: "/api/knowledge/digest",
    handler: async (request) => startOperation(request, "knowledge.digest"),
  },
  {
    method: "GET",
    pattern: "/api/operations/:operationId",
    async handler(request) {
      const id = request.params.operationId;
      const operation = id ? request.database.getOperation(id) : undefined;
      if (!operation) throw notFound("找不到操作。");
      return { body: { operation: toOperationDto(operation) } };
    },
  },
];

async function startOperation(
  request: RouteRequest,
  kind: OperationKind,
): Promise<{ status: number; body: unknown }> {
  const start = request.database.createOperation(kind, request.now);
  if (start.busy) {
    throw new ApiError(409, "CONFLICT", "另一项知识任务正在运行，请等待完成。");
  }
  if (!start.created) {
    return { status: 202, body: { operation: toOperationDto(start.operation) } };
  }
  const operation = request.database.startOperation(
    start.operation.id,
    kind === "knowledge.sync" ? "syncing" : "digesting",
    request.now,
  );
  void runOperation(request, operation, kind);
  return { status: 202, body: { operation: toOperationDto(operation) } };
}

async function runOperation(
  request: RouteRequest,
  operation: Operation,
  kind: OperationKind,
): Promise<void> {
  try {
    const onStage = (stage: string): void => {
      request.database.updateOperationStage(operation.id, stage);
    };
    const result =
      kind === "knowledge.sync"
        ? await request.services.knowledge.sync(request, onStage)
        : await request.services.knowledge.digest(request, onStage);
    request.database.succeedOperation(operation.id, result, new Date());
    request.logger?.("knowledge_operation_succeeded", { operationId: operation.id, kind });
  } catch (error) {
    const message = safeErrorMessage(error, "知识任务失败。");
    request.database.failOperation(operation.id, message, new Date());
    request.logger?.("knowledge_operation_failed", {
      operationId: operation.id,
      kind,
      error: message,
    });
  }
}

function toOperationDto(operation: Operation): OperationDto {
  return {
    id: operation.id,
    kind: operation.kind,
    status: operation.status,
    stage: operation.stage,
    progressCurrent: operation.progressCurrent,
    progressTotal: operation.progressTotal,
    result: operation.result,
    error: operation.error,
    createdAt: operation.createdAt,
    startedAt: operation.startedAt,
    completedAt: operation.completedAt,
  };
}
