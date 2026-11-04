import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { isStandardMessage } from "./message-text.js";

/**
 * Conservative local token estimate.
 *
 * The project intentionally avoids shipping a tokenizer for the first version:
 * the estimate only has to be pessimistic enough that a request stays inside the
 * model window. CJK characters count as one token each, ASCII as roughly three
 * characters per token, and every message carries a small structural overhead.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    if (isCjk(character)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other * 0.3);
}

export function estimateMessageTokens(message: AgentMessage): number {
  if (!isStandardMessage(message)) return 4;
  const content = message.content;
  let tokens = 4;
  if (typeof content === "string") {
    tokens += estimateTextTokens(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text") tokens += estimateTextTokens(block.text);
      else if (block.type === "thinking") tokens += estimateTextTokens(block.thinking);
      else if (block.type === "toolCall") tokens += estimateTextTokens(JSON.stringify(block.arguments ?? {}));
    }
  }
  if (message.role === "toolResult") {
    tokens += estimateTextTokens(message.toolName);
    tokens += estimateTextTokens(JSON.stringify(message.details ?? {}));
  }
  return tokens;
}

export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}

function isCjk(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    (code >= 0x3040 && code <= 0x30ff) || // kana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
    (code >= 0xac00 && code <= 0xd7af) || // hangul
    (code >= 0xf900 && code <= 0xfaff) // CJK compatibility
  );
}
