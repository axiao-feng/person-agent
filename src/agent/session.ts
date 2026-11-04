import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";

import { createAssistant } from "../agent.js";
import type { AppConfig } from "../config.js";
import {
  type AgentConversation,
  type AgentSummary,
  type AgentTranscriptEntry,
  AppDatabase,
} from "../database.js";
import type { AppPaths } from "../paths.js";
import type { ContextManifest, ConversationContextOptions } from "./context.js";
import { isStandardMessage } from "./message-text.js";
import { type SummaryGenerator, refreshConversationSummary } from "./summary.js";
export { messageText } from "./message-text.js";

/** A local object an answer was actually derived from. Empty until P2 reference collection lands. */
export type AgentReference = {
  type: "paper" | "task" | "idea" | "lecture" | "approval";
  id: string;
  title: string;
};

/** How many confirmed memories are eligible for prompt injection per request. */
export const SESSION_MEMORY_LIMIT = 20;

export type ConversationTurnResult = {
  conversation: AgentConversation;
  answer: string;
  references: AgentReference[];
  /** Messages persisted by this turn, including the user message. */
  messages: AgentTranscriptEntry[];
  /** Manifest of the last model request in this turn, for debugging and tests. */
  context: ContextManifest | null;
  summaryId: string | null;
};

export type CreateConversationAgent = (
  history: AgentMessage[],
  conversationId: string,
  context: ConversationContextOptions,
) => Promise<Agent>;

export type ConversationTurnOptions = {
  database: AppDatabase;
  message: string;
  conversationId?: string;
  createAgent: CreateConversationAgent;
  now?: Date;
  /** Enables history compaction after the turn. Omitted in tests that have no model. */
  summary?: {
    generate: SummaryGenerator;
    onError?: (error: unknown) => void;
  };
  memories?: ConversationContextOptions["memories"];
  budgetTokens?: number;
  onContext?: (manifest: ContextManifest) => void;
};

export class ConversationNotFoundError extends Error {
  constructor(readonly conversationId: string) {
    super("找不到该会话，可能已被删除。");
    this.name = "ConversationNotFoundError";
  }
}

export class ConversationArchivedError extends Error {
  constructor(readonly conversationId: string) {
    super("该会话已归档，请新建会话或先取消归档。");
    this.name = "ConversationArchivedError";
  }
}

export class AgentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUnavailableError";
  }
}

/**
 * Runs one chat turn against a persisted conversation.
 *
 * The user message is written before the model call, every produced
 * assistant/tool message is written afterwards in a single transaction, and the
 * next turn replays the stored transcript. Each model request is assembled by the
 * Context Builder instead of sending the raw history unbounded.
 */
export async function runConversationTurn(options: ConversationTurnOptions): Promise<ConversationTurnResult> {
  const now = options.now ?? new Date();
  const text = options.message.trim();
  if (!text) throw new Error("消息不能为空。");

  let conversation = options.conversationId
    ? options.database.getAgentConversation(options.conversationId)
    : undefined;
  if (options.conversationId && !conversation) throw new ConversationNotFoundError(options.conversationId);
  if (!conversation) conversation = options.database.createAgentConversation(undefined, now);
  if (conversation.status === "archived") throw new ConversationArchivedError(conversation.id);

  const history = loadConversationHistory(options.database, conversation.id);
  if (!conversation.title) {
    conversation = options.database.updateAgentConversation(
      conversation.id,
      { title: conversationTitleFrom(text) },
      now,
    );
  }

  const userMessage: AgentMessage = { role: "user", content: text, timestamp: now.getTime() };
  const persisted = options.database.appendAgentTranscript(
    conversation.id,
    [{ role: "user", message: userMessage }],
    now,
  );

  const activeSummary = options.database.getActiveAgentSummary(conversation.id);
  const memories =
    options.memories ??
    options.database
      .listAgentMemories({ limit: SESSION_MEMORY_LIMIT, now })
      .map((memory) => ({ id: memory.id, kind: memory.kind, content: memory.content }));
  const manifests: ContextManifest[] = [];
  const context: ConversationContextOptions = {
    summary: activeSummary ? summaryContext(activeSummary) : null,
    memories,
    ...(options.budgetTokens ? { budgetTokens: options.budgetTokens } : {}),
    onRequest: (manifest) => {
      manifests.push(manifest);
      options.onContext?.(manifest);
    },
  };

  const agent = await options.createAgent(history, conversation.id, context);
  const baseline = agent.state.messages.length;
  let produced: AgentMessage[] = [];
  try {
    await agent.prompt(userMessage);
  } finally {
    produced = newAssistantMessages(agent.state.messages.slice(baseline));
    if (produced.length > 0) {
      persisted.push(
        ...options.database.appendAgentTranscript(
          conversation.id,
          produced.map((message) => ({ role: message.role, message })),
          now,
        ),
      );
    }
  }

  const answer = lastAssistantText(produced);
  if (!answer) {
    throw new AgentUnavailableError(
      agent.state.errorMessage ?? "Agent 没有返回文本结果，请稍后重试。",
    );
  }

  let summaryId: string | null = null;
  if (options.summary) {
    try {
      const summary = await refreshConversationSummary({
        database: options.database,
        conversationId: conversation.id,
        generate: options.summary.generate,
        now,
      });
      summaryId = summary?.id ?? null;
    } catch (error) {
      // Compaction is best-effort: a failed summary must not lose the answer.
      options.summary.onError?.(error);
    }
  }

  return {
    conversation: options.database.getAgentConversation(conversation.id) ?? conversation,
    answer,
    references: [],
    messages: persisted,
    context: manifests.at(-1) ?? null,
    summaryId,
  };
}

/** Replays a stored transcript for the next prompt. Invalid or dangling entries are dropped. */
export function loadConversationHistory(database: AppDatabase, conversationId: string): AgentMessage[] {
  const stored = database.listAgentTranscript(conversationId);
  const messages = stored
    .map((entry) => entry.message)
    .filter((message): message is AgentMessage => isAgentMessage(message))
    .filter((message) => message.role !== "system");
  while (messages.length > 0) {
    const last = messages[messages.length - 1]!;
    if (last.role !== "assistant" || !hasUnansweredToolCall(last)) break;
    messages.pop();
  }
  return messages;
}

export function conversationAgentFactory(options: {
  paths: AppPaths;
  config: AppConfig;
  database: AppDatabase;
}): CreateConversationAgent {
  return async (history, conversationId, context) =>
    await createAssistant({
      paths: options.paths,
      config: options.config,
      database: options.database,
      ...(history.length > 0 ? { messages: history } : {}),
      sessionId: conversationId,
      context,
    });
}

export function conversationTitleFrom(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= 40 ? single : `${single.slice(0, 39)}…`;
}

function summaryContext(summary: AgentSummary): NonNullable<ConversationContextOptions["summary"]> {
  return { id: summary.id, text: summary.summary, toSequence: summary.toSequence };
}

function lastAssistantText(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    const text = textFrom(message).trim();
    if (text) return text;
  }
  return "";
}

function newAssistantMessages(produced: AgentMessage[]): AgentMessage[] {
  const rest = produced.slice();
  if (rest[0]?.role === "user") rest.shift();
  return rest;
}

function textFrom(message: AgentMessage): string {
  if (!isStandardMessage(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("")
    .trim();
}

function hasUnansweredToolCall(message: Extract<AgentMessage, { role: "assistant" }>): boolean {
  return message.content.some((block) => block.type === "toolCall");
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const role = (value as { role?: unknown }).role;
  return role === "user" || role === "assistant" || role === "toolResult" || role === "system";
}
