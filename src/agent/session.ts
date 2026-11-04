import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";

import { createAssistant } from "../agent.js";
import type { AppConfig } from "../config.js";
import {
  type AgentConversation,
  type AgentTranscriptEntry,
  AppDatabase,
} from "../database.js";
import type { AppPaths } from "../paths.js";

/** A local object an answer was actually derived from. Empty until P2 reference collection lands. */
export type AgentReference = {
  type: "paper" | "task" | "idea" | "lecture" | "approval";
  id: string;
  title: string;
};

export type ConversationTurnResult = {
  conversation: AgentConversation;
  answer: string;
  references: AgentReference[];
  /** Messages persisted by this turn, including the user message. */
  messages: AgentTranscriptEntry[];
};

export type CreateConversationAgent = (history: AgentMessage[], conversationId: string) => Promise<Agent>;

export type ConversationTurnOptions = {
  database: AppDatabase;
  message: string;
  conversationId?: string;
  createAgent: CreateConversationAgent;
  now?: Date;
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
 * next turn replays the whole transcript as `initialState.messages`.
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

  const agent = await options.createAgent(history, conversation.id);
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

  return {
    conversation: options.database.getAgentConversation(conversation.id) ?? conversation,
    answer,
    references: [],
    messages: persisted,
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
  return async (history, conversationId) =>
    await createAssistant({
      paths: options.paths,
      config: options.config,
      database: options.database,
      ...(history.length > 0 ? { messages: history } : {}),
      sessionId: conversationId,
    });
}

/** Display text for one transcript message; never includes raw tool payloads. */
export function messageText(message: AgentMessage): string {
  switch (message.role) {
    case "user":
      return textContent(message.content);
    case "assistant": {
      const text = textContent(message.content);
      if (text) return text;
      const calls = message.content
        .filter((block): block is Extract<(typeof message.content)[number], { type: "toolCall" }> => block.type === "toolCall")
        .map((call) => call.name);
      return calls.length > 0 ? `（调用工具 ${calls.join("、")}）` : "";
    }
    case "toolResult":
      return textContent(message.content);
    case "system":
      return typeof message.content === "string" ? message.content : textContent(message.content);
    default:
      return "";
  }
}

export function conversationTitleFrom(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= 40 ? single : `${single.slice(0, 39)}…`;
}

function lastAssistantText(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    const text = textContent(message.content).trim();
    if (text) return text;
  }
  return "";
}

function newAssistantMessages(produced: AgentMessage[]): AgentMessage[] {
  const rest = produced.slice();
  if (rest[0]?.role === "user") rest.shift();
  return rest;
}

function textContent(content: unknown): string {
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
