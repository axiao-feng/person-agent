import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { estimateMessageTokens, estimateMessagesTokens, estimateTextTokens } from "./tokens.js";

/** Minimal shape of a confirmed long-term memory used for prompt assembly. */
export type ContextMemory = {
  id: string;
  kind: string;
  content: string;
};

/** The persisted summary of earlier turns that no longer fit in the window. */
export type ContextSummary = {
  id: string;
  text: string;
  toSequence: number;
};

export type BuildContextInput = {
  messages: AgentMessage[];
  /** Prompt budget in tokens; output/tool reserve is already subtracted. */
  budgetTokens: number;
  summary?: ContextSummary | null;
  memories?: ContextMemory[];
  /** Estimated tokens consumed by tool declarations. */
  toolTokens?: number;
};

export type ContextManifest = {
  budgetTokens: number;
  estimatedTokens: number;
  systemTokens: number;
  toolTokens: number;
  summaryId: string | null;
  summaryTokens: number;
  memoryIds: string[];
  memoryTokens: number;
  keptMessages: number;
  droppedMessages: number;
};

export type BuiltContext = {
  messages: AgentMessage[];
  manifest: ContextManifest;
};

/** Options passed from the session layer into `createAssistant`. */
export type ConversationContextOptions = {
  summary?: ContextSummary | null;
  memories?: ContextMemory[];
  /** Prompt budget in tokens; the output reserve is subtracted by the caller when omitted. */
  budgetTokens?: number;
  toolTokenEstimate?: number;
  onRequest?: (manifest: ContextManifest) => void;
};

/**
 * Assembles one model request from the persisted transcript.
 *
 * Order follows `docs/05-agent-technology-stack.md` §4.1: leading system rules →
 * history summary → confirmed memories → the most recent messages that still fit
 * the budget. A dropped assistant tool call never leaves an orphan tool result.
 */
export function buildConversationContext(input: BuildContextInput): BuiltContext {
  const messages = input.messages;
  const leading: AgentMessage[] = [];
  let index = 0;
  while (index < messages.length && messages[index]!.role === "system") {
    leading.push(messages[index]!);
    index += 1;
  }
  const rest = messages.slice(index);

  const toolTokens = Math.max(0, input.toolTokens ?? 0);
  const systemTokens = estimateMessagesTokens(leading);

  const summaryText = input.summary?.text?.trim() ? input.summary.text.trim() : "";
  const summaryMessage: AgentMessage | null = summaryText
    ? {
        role: "system",
        content: `[较早对话摘要，已覆盖到第 ${input.summary?.toSequence ?? 0} 条消息]\n${summaryText}`,
        timestamp: Date.now(),
      }
    : null;
  const memoryLines = (input.memories ?? [])
    .filter((memory) => memory.content.trim())
    .map((memory) => `- [${memory.kind}] ${memory.content.trim()}`);
  const memoryMessage: AgentMessage | null =
    memoryLines.length > 0
      ? {
          role: "system",
          content: `[已确认的长期记忆，按重要度排序]\n${memoryLines.join("\n")}`,
          timestamp: Date.now(),
        }
      : null;

  let injected: AgentMessage[] = [];
  if (summaryMessage) injected.push(summaryMessage);
  if (memoryMessage) injected.push(memoryMessage);
  const fixedTokens = toolTokens + systemTokens;
  let tailBudget = input.budgetTokens - fixedTokens - estimateMessagesTokens(injected);

  const lastUserIndex = findLastUserIndex(rest);
  // Guarantee the current user question survives even when it alone exceeds the budget.
  const lastUserTokens = lastUserIndex >= 0 ? estimateMessageTokens(rest[lastUserIndex]!) : 0;
  if (tailBudget < lastUserTokens) {
    injected = [];
    tailBudget = input.budgetTokens - fixedTokens;
  }

  const { start, used } = selectTail(rest, lastUserIndex, tailBudget);
  const kept = rest.slice(start);
  const output = [...leading, ...injected, ...kept];

  const summaryIncluded = summaryMessage !== null && injected.includes(summaryMessage);
  const memoryIncluded = memoryMessage !== null && injected.includes(memoryMessage);
  const manifest: ContextManifest = {
    budgetTokens: input.budgetTokens,
    estimatedTokens: systemTokens + toolTokens + estimateMessagesTokens(injected) + used,
    systemTokens,
    toolTokens,
    summaryId: summaryIncluded ? (input.summary?.id ?? null) : null,
    summaryTokens: summaryIncluded ? estimateMessageTokens(summaryMessage) : 0,
    memoryIds: memoryIncluded ? (input.memories ?? []).map((memory) => memory.id) : [],
    memoryTokens: memoryIncluded ? estimateMessageTokens(memoryMessage) : 0,
    keptMessages: kept.length,
    droppedMessages: rest.length - kept.length,
  };

  return { messages: output, manifest };
}

/** Rough estimate of tool-schema overhead so it is reserved before history is trimmed. */
export function estimateToolTokens(toolCount: number): number {
  return Math.max(1_000, toolCount * 400);
}

/**
 * Builds the `transformContext` hook used by `createAssistant`.
 * Exported so tests can exercise the exact same assembly path.
 */
export function contextTransform(options: {
  context: ConversationContextOptions;
  budgetTokens: number;
  toolTokens: number;
}): (messages: AgentMessage[]) => Promise<AgentMessage[]> {
  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    const built = buildConversationContext({
      messages,
      budgetTokens: options.budgetTokens,
      summary: options.context.summary ?? null,
      memories: options.context.memories ?? [],
      toolTokens: options.toolTokens,
    });
    options.context.onRequest?.(built.manifest);
    return built.messages;
  };
}

export function renderTranscript(messages: readonly AgentMessage[], textOf: (message: AgentMessage) => string): string {
  return messages
    .map((message) => {
      const label =
        message.role === "user"
          ? "用户"
          : message.role === "assistant"
            ? "助理"
            : message.role === "toolResult"
              ? `工具 ${message.toolName}`
              : "系统";
      const text = textOf(message).trim();
      return text ? `${label}：${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function estimateRenderedTranscriptTokens(text: string): number {
  return estimateTextTokens(text);
}

function findLastUserIndex(messages: readonly AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === "user") return index;
  }
  return -1;
}

function selectTail(
  messages: readonly AgentMessage[],
  lastUserIndex: number,
  budgetTokens: number,
): { start: number; used: number } {
  let start = messages.length;
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const cost = estimateMessageTokens(messages[index]!);
    const isLastUser = index === lastUserIndex;
    if (!isLastUser && used + cost > budgetTokens) break;
    used += cost;
    start = index;
  }
  if (start === messages.length) {
    // Nothing fit; keep the tail message so the request still carries a question.
    start = Math.max(0, messages.length - 1);
  }
  // Prefer starting on a user turn: this keeps tool pairs intact and avoids
  // assistant prefill, which some providers reject as the first message.
  if (messages[start]?.role !== "user") {
    const nextUser = nextUserIndex(messages, start);
    start = nextUser >= 0 ? nextUser : skipLeadingToolResults(messages, start);
  }
  return { start, used: estimateMessagesTokens(messages.slice(start)) };
}

function nextUserIndex(messages: readonly AgentMessage[], from: number): number {
  for (let index = from; index < messages.length; index += 1) {
    if (messages[index]!.role === "user") return index;
  }
  return -1;
}

function skipLeadingToolResults(messages: readonly AgentMessage[], from: number): number {
  let start = from;
  while (start < messages.length && messages[start]!.role === "toolResult") start += 1;
  return start < messages.length ? start : from;
}
