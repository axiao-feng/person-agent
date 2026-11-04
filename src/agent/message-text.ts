import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** The standard LLM roles; custom app messages (bash, custom, summary) are filtered out. */
export type StandardAgentMessage = Extract<
  AgentMessage,
  { role: "system" | "user" | "assistant" | "toolResult" }
>;

export function isStandardMessage(message: AgentMessage): message is StandardAgentMessage {
  return (
    message.role === "system" ||
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "toolResult"
  );
}

/** Display text for one transcript message; never includes raw tool payloads. */
export function messageText(message: AgentMessage): string {
  if (!isStandardMessage(message)) return "";
  switch (message.role) {
    case "user":
      return textContent(message.content);
    case "assistant": {
      const text = textContent(message.content);
      if (text) return text;
      const calls = message.content
        .filter(
          (block): block is Extract<(typeof message.content)[number], { type: "toolCall" }> =>
            block.type === "toolCall",
        )
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
