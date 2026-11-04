import {
  AgentUnavailableError,
  ConversationArchivedError,
  ConversationNotFoundError,
} from "../../agent/session.js";
import { AGENT_CONVERSATION_TITLE_MAX, type AgentConversationStatus } from "../../database.js";
import { conversationDto, transcriptDto } from "../conversation-data.js";
import type { Route, RouteRequest } from "../context.js";
import { ApiError, safeErrorMessage } from "../errors.js";
import { notFound, objectBody, validation } from "../http.js";
import type {
  AgentReferenceDto,
  ConversationDto,
  TranscriptMessageDto,
} from "../types.js";

export type AgentTurnBody = {
  conversationId: string;
  answer: string;
  references: AgentReferenceDto[];
  conversation: ConversationDto;
  messages: TranscriptMessageDto[];
};

const STATUSES: readonly AgentConversationStatus[] = ["active", "archived"];

export const conversationRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/api/conversations",
    async handler(request) {
      const body = request.body === undefined ? {} : objectBody(request.body);
      const title = optionalTitle(body.title);
      const conversation = request.database.createAgentConversation(title, request.now);
      return { status: 201, body: { conversation: conversationDto(conversation) } };
    },
  },
  {
    method: "GET",
    pattern: "/api/conversations",
    async handler(request) {
      const statusText = request.query.get("status");
      if (statusText && !STATUSES.includes(statusText as AgentConversationStatus)) {
        throw validation("会话状态无效。", "status", "会话状态无效。");
      }
      const limit = boundedQuery(request, "limit", 20, 1, 50);
      const conversations = request.database.listAgentConversations({
        ...(statusText ? { status: statusText as AgentConversationStatus } : {}),
        limit,
      });
      return { body: { items: conversations.map(conversationDto) } };
    },
  },
  {
    method: "GET",
    pattern: "/api/conversations/:conversationId/messages",
    async handler(request) {
      const conversationId = requiredConversationId(request);
      const conversation = request.database.getAgentConversation(conversationId);
      if (!conversation) throw notFound("找不到该会话，可能已被删除。");
      const limit = boundedQuery(request, "limit", 200, 20, 500);
      const entries = request.database.listAgentTranscript(conversationId);
      const messages = entries.slice(Math.max(0, entries.length - limit)).map(transcriptDto);
      return { body: { conversation: conversationDto(conversation), messages } };
    },
  },
  {
    method: "POST",
    pattern: "/api/conversations/:conversationId/messages",
    async handler(request) {
      const conversationId = requiredConversationId(request);
      const body = objectBody(request.body);
      const message = requiredMessage(body.message);
      return { body: await sendAgentTurn(request, conversationId, message) };
    },
  },
  {
    method: "PATCH",
    pattern: "/api/conversations/:conversationId",
    async handler(request) {
      const conversationId = requiredConversationId(request);
      const body = objectBody(request.body);
      if (!("title" in body) && !("status" in body)) {
        throw validation("至少需要提供 title 或 status。", "title", "至少需要提供 title 或 status。");
      }
      const patch: { title?: string | null; status?: AgentConversationStatus } = {};
      if ("title" in body) patch.title = optionalTitle(body.title) ?? null;
      if ("status" in body) {
        const status = body.status;
        if (typeof status !== "string" || !STATUSES.includes(status as AgentConversationStatus)) {
          throw validation("会话状态无效。", "status", "会话状态无效。");
        }
        patch.status = status as AgentConversationStatus;
      }
      try {
        const conversation = request.database.updateAgentConversation(conversationId, patch, request.now);
        return { body: { conversation: conversationDto(conversation) } };
      } catch (error) {
        if (isMissingConversation(error)) throw notFound("找不到该会话，可能已被删除。");
        throw error;
      }
    },
  },
  {
    method: "DELETE",
    pattern: "/api/conversations/:conversationId",
    async handler(request) {
      const conversationId = requiredConversationId(request);
      if (!request.database.deleteAgentConversation(conversationId)) {
        throw notFound("找不到该会话，可能已被删除。");
      }
      return { body: { conversationId, deleted: true } };
    },
  },
];

/** Shared by `POST /api/agent/messages` so both entry points persist the same way. */
export async function sendAgentTurn(
  request: RouteRequest,
  conversationId: string | undefined,
  message: string,
): Promise<AgentTurnBody> {
  try {
    const turn = await request.services.agent(request, {
      message,
      ...(conversationId ? { conversationId } : {}),
    });
    return {
      conversationId: turn.conversation.id,
      answer: turn.answer,
      references: turn.references,
      conversation: conversationDto(turn.conversation),
      messages: turn.messages.map(transcriptDto),
    };
  } catch (error) {
    if (error instanceof ConversationNotFoundError) throw notFound(error.message);
    if (error instanceof ConversationArchivedError) throw new ApiError(409, "CONFLICT", error.message);
    if (error instanceof ApiError) throw error;
    const unavailable =
      error instanceof AgentUnavailableError
        ? error.message
        : safeErrorMessage(error, "Agent 暂时不可用。");
    throw new ApiError(503, "DEPENDENCY_UNAVAILABLE", unavailable, true);
  }
}

export function requiredMessage(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw validation("消息不能为空。", "message", "消息不能为空。");
  }
  const message = value.trim();
  if (message.length > 20_000) {
    throw validation("消息不能超过 20000 个字符。", "message", "消息不能超过 20000 个字符。");
  }
  return message;
}

function optionalTitle(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw validation("会话标题必须是文本。", "title", "会话标题必须是文本。");
  const title = value.trim();
  if (!title) return undefined;
  if (title.length > AGENT_CONVERSATION_TITLE_MAX) {
    throw validation(
      `会话标题不能超过 ${AGENT_CONVERSATION_TITLE_MAX} 个字符。`,
      "title",
      `会话标题不能超过 ${AGENT_CONVERSATION_TITLE_MAX} 个字符。`,
    );
  }
  return title;
}

function requiredConversationId(request: RouteRequest): string {
  const conversationId = request.params.conversationId;
  if (!conversationId) throw validation("缺少 conversationId 参数。", "conversationId");
  return conversationId;
}

function boundedQuery(
  request: RouteRequest,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const text = request.query.get(name);
  if (text === null) return fallback;
  if (!/^\d+$/.test(text)) {
    throw validation(`${name} 必须是 ${minimum}–${maximum} 的整数。`, name);
  }
  const value = Number(text);
  if (value < minimum || value > maximum) {
    throw validation(`${name} 必须是 ${minimum}–${maximum} 的整数。`, name);
  }
  return value;
}

function isMissingConversation(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("找不到会话");
}
