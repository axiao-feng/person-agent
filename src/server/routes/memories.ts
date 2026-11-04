import {
  AGENT_MEMORY_KINDS,
  AGENT_MEMORY_SOURCE_TYPES,
  type AgentMemory,
  type AgentMemoryInput,
  type AgentMemoryKind,
  type AgentMemorySourceType,
} from "../../database.js";
import type { Route, RouteRequest } from "../context.js";
import { ApiError } from "../errors.js";
import {
  enumField,
  integerQuery,
  notFound,
  objectBody,
  optionalInstantField,
  optionalIntegerField,
  optionalString,
  requiredString,
  validation,
} from "../http.js";
import type { AgentMemoryDto } from "../types.js";

export const memoryRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/memories",
    async handler(request) {
      const kindText = request.query.get("kind");
      if (kindText && !AGENT_MEMORY_KINDS.includes(kindText as AgentMemoryKind)) {
        throw validation("记忆类型无效。", "kind", "记忆类型无效。");
      }
      const limit = integerQuery(request.query, "limit", 50, 1, 100);
      const query = request.query.get("query")?.trim();
      const memories = request.database.listAgentMemories({
        ...(kindText ? { kind: kindText as AgentMemoryKind } : {}),
        ...(query ? { query } : {}),
        limit,
        now: request.now,
      });
      return { body: { items: memories.map(memoryDto) } };
    },
  },
  {
    method: "POST",
    pattern: "/api/memories",
    async handler(request) {
      const body = objectBody(request.body);
      const kind = enumField(body, "kind", "记忆类型", AGENT_MEMORY_KINDS) ?? "preference";
      const content = requiredString(body, "content", "记忆内容", 1_000);
      const sourceType = enumField(body, "sourceType", "记忆来源", AGENT_MEMORY_SOURCE_TYPES);
      const sourceId = optionalString(body, "sourceId", "来源 ID", 200);
      const importance = optionalIntegerField(body, "importance", "重要度", 1, 5);
      const validUntil = optionalInstantField(body, "validUntil", "失效时间");
      const input: AgentMemoryInput = {
        kind,
        content,
        sourceType: sourceType ?? "explicit_user",
        ...(sourceId ? { sourceId } : {}),
        ...(importance === undefined ? {} : { importance }),
        ...(validUntil ? { validUntil } : {}),
      };
      try {
        const result = request.database.createAgentMemory(input, request.now);
        return {
          status: result.created ? 201 : 200,
          body: { memory: memoryDto(result.memory), created: result.created },
        };
      } catch (error) {
        throw asValidation(error);
      }
    },
  },
  {
    method: "PATCH",
    pattern: "/api/memories/:memoryId",
    async handler(request) {
      const memoryId = requiredMemoryId(request);
      const body = objectBody(request.body);
      if (!("kind" in body) && !("content" in body) && !("importance" in body) && !("validUntil" in body)) {
        throw validation("至少需要提供 kind、content、importance 或 validUntil。", "content");
      }
      const kind = enumField(body, "kind", "记忆类型", AGENT_MEMORY_KINDS);
      const content = "content" in body ? requiredString(body, "content", "记忆内容", 1_000) : undefined;
      const importance = optionalIntegerField(body, "importance", "重要度", 1, 5);
      const validUntil = optionalInstantField(body, "validUntil", "失效时间");
      try {
        const memory = request.database.updateAgentMemory(
          memoryId,
          {
            ...(kind ? { kind } : {}),
            ...(content ? { content } : {}),
            ...(importance === undefined ? {} : { importance }),
            ...(validUntil === undefined ? {} : { validUntil }),
          },
          request.now,
        );
        return { body: { memory: memoryDto(memory) } };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("找不到记忆")) {
          throw notFound("找不到该记忆。");
        }
        throw asValidation(error);
      }
    },
  },
  {
    method: "DELETE",
    pattern: "/api/memories/:memoryId",
    async handler(request) {
      const memoryId = requiredMemoryId(request);
      if (!request.database.getAgentMemory(memoryId)) throw notFound("找不到该记忆。");
      const memory = request.database.deleteAgentMemory(memoryId, request.now);
      return { body: { memoryId, deleted: true, memory: memoryDto(memory) } };
    },
  },
];

export function memoryDto(memory: AgentMemory): AgentMemoryDto {
  return {
    id: memory.id,
    kind: memory.kind,
    content: memory.content,
    sourceType: memory.sourceType,
    sourceId: memory.sourceId,
    confidence: memory.confidence,
    importance: memory.importance,
    validUntil: memory.validUntil,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

function requiredMemoryId(request: RouteRequest): string {
  const memoryId = request.params.memoryId;
  if (!memoryId) throw validation("缺少 memoryId 参数。", "memoryId");
  return memoryId;
}

function asValidation(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const message = error instanceof Error ? error.message : "记忆操作失败。";
  return new ApiError(422, "VALIDATION_FAILED", message);
}

export type { AgentMemorySourceType };
