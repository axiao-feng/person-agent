import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { buildConversationContext, contextTransform } from "../src/agent/context.js";
import type { ContextSummary } from "../src/agent/context.js";
import { messageText } from "../src/agent/message-text.js";
import {
  parseSummaryDraft,
  refreshConversationSummary,
  SUMMARY_KEEP_RECENT,
  SUMMARY_TRIGGER_MESSAGES,
} from "../src/agent/summary.js";
import { estimateTextTokens } from "../src/agent/tokens.js";
import { AppDatabase } from "../src/database.js";

const NOW = new Date("2026-11-04T02:00:00.000Z");

test("CJK text is estimated conservatively", () => {
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens("中文四个字"), 5);
  assert.equal(estimateTextTokens("abcdefghij"), 3);
  assert.equal(estimateTextTokens("论文检索"), 4);
});

test("the builder drops old turns but keeps system rules and the current question", () => {
  const messages: AgentMessage[] = [system("系统规则")];
  for (let turn = 0; turn < 40; turn += 1) {
    messages.push(user(`问题 ${turn} `.repeat(20)));
    messages.push(assistant(`回答 ${turn} `.repeat(20)));
  }
  messages.push(user("当前问题"));

  const built = buildConversationContext({ messages, budgetTokens: 400 });
  assert.equal(built.messages[0]?.role, "system");
  const last = built.messages.at(-1);
  assert.equal(last?.role, "user");
  assert.equal(messageText(last as AgentMessage), "当前问题");
  assert.ok(built.manifest.droppedMessages > 0);
  assert.ok(built.manifest.estimatedTokens <= 400);
  // The tail must start on a turn boundary, never with an orphan tool result.
  assert.notEqual(built.messages[1]?.role, "toolResult");
});

test("a trimmed transcript never begins with an orphan tool result", () => {
  const messages: AgentMessage[] = [
    system("系统规则"),
    user("查一下日程"),
    assistantToolCall("list_calendar_events"),
    toolResult("list_calendar_events", "两个会议"),
    assistant("今天有两个会议。"),
    user("第二个会议几点"),
  ];
  const built = buildConversationContext({ messages, budgetTokens: 40, toolTokens: 0 });
  assert.equal(built.messages[0]?.role, "system");
  assert.equal(built.messages[1]?.role, "user");
  assert.equal(messageText(built.messages[1] as AgentMessage), "第二个会议几点");
});

test("the summary and confirmed memories are injected before the recent tail", () => {
  const summary: ContextSummary = { id: "summary-1", text: "用户想安排本周的论文阅读。", toSequence: 12 };
  const built = buildConversationContext({
    messages: [system("系统规则"), user("继续"), assistant("好的")],
    budgetTokens: 4_000,
    summary,
    memories: [{ id: "memory-1", kind: "preference", content: "偏好上午阅读论文" }],
  });
  assert.equal(built.messages[0]?.role, "system");
  assert.equal(built.messages[1]?.role, "system");
  assert.match(String(built.messages[1]?.content), /较早对话摘要/);
  assert.equal(built.messages[2]?.role, "system");
  assert.match(String(built.messages[2]?.content), /偏好上午阅读论文/);
  assert.equal(built.messages[3]?.role, "user");
  assert.equal(built.manifest.summaryId, "summary-1");
  assert.deepEqual(built.manifest.memoryIds, ["memory-1"]);
  assert.equal(built.manifest.droppedMessages, 0);
});

test("injections are dropped before the current question when the budget is tight", () => {
  const summary: ContextSummary = { id: "summary-1", text: "很长的历史摘要".repeat(50), toSequence: 12 };
  const built = buildConversationContext({
    messages: [system("系统规则"), user("当前问题")],
    budgetTokens: 60,
    summary,
  });
  assert.equal(built.manifest.summaryId, null);
  assert.equal(messageText(built.messages.at(-1) as AgentMessage), "当前问题");
});

test("the transform reports a manifest for every model request", async () => {
  const manifests: string[] = [];
  const transform = contextTransform({
    context: { onRequest: (manifest) => manifests.push(`${manifest.keptMessages}/${manifest.droppedMessages}`) },
    budgetTokens: 1_000,
    toolTokens: 100,
  });
  const output = await transform([system("系统规则"), user("你好"), assistant("你好")]);
  assert.equal(output.length, 3);
  assert.deepEqual(manifests, ["2/0"]);
});

test("summaries only cover the declared range and supersede the previous version", async () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-summary-test-"));
  const database = new AppDatabase(join(root, "test.db"));
  try {
    const conversation = database.createAgentConversation("长对话", NOW);
    appendPairs(database, conversation.id, 25); // 50 messages
    const prompts: string[] = [];
    const summary = await refreshConversationSummary({
      database,
      conversationId: conversation.id,
      now: NOW,
      generate: async (input) => {
        prompts.push(input.transcript);
        return { summary: "前段摘要", openQuestions: ["还没决定时间"] };
      },
    });
    assert.ok(summary);
    const total = database.countAgentMessages(conversation.id);
    assert.equal(summary.toSequence, total - SUMMARY_KEEP_RECENT);
    assert.equal(summary.fromSequence, 1);
    assert.equal(summary.openQuestions[0], "还没决定时间");
    assert.match(prompts[0] ?? "", /用户：问题 0/);

    // Not enough new messages yet: no second summary.
    const again = await refreshConversationSummary({
      database,
      conversationId: conversation.id,
      now: NOW,
      generate: async () => ({ summary: "不该出现", openQuestions: [] }),
    });
    assert.equal(again, null);

    appendPairs(database, conversation.id, SUMMARY_TRIGGER_MESSAGES / 2);
    const second = await refreshConversationSummary({
      database,
      conversationId: conversation.id,
      now: NOW,
      generate: async () => ({ summary: "第二版摘要", openQuestions: [] }),
    });
    assert.ok(second);
    assert.equal(second.fromSequence, summary.toSequence + 1);
    const active = database.getActiveAgentSummary(conversation.id);
    assert.equal(active?.id, second.id);
    const all = database.listAgentSummaries(conversation.id);
    assert.equal(all.length, 2);
    assert.equal(all[0]?.supersededBy, second.id);
    assert.equal(database.countAgentMessages(conversation.id), total + SUMMARY_TRIGGER_MESSAGES);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("summary drafts fall back to raw text when the model ignores the JSON contract", () => {
  assert.deepEqual(parseSummaryDraft('{"summary":"压缩结果","openQuestions":["问题一"]}'), {
    summary: "压缩结果",
    openQuestions: ["问题一"],
  });
  assert.deepEqual(parseSummaryDraft("```json\n{\"summary\":\"带围栏\"}\n```"), {
    summary: "带围栏",
    openQuestions: [],
  });
  assert.deepEqual(parseSummaryDraft("纯文本摘要"), { summary: "纯文本摘要", openQuestions: [] });
});

function appendPairs(database: AppDatabase, conversationId: string, pairs: number): void {
  const entries = [];
  const start = database.countAgentMessages(conversationId);
  for (let index = 0; index < pairs; index += 1) {
    entries.push({
      role: "user",
      message: { role: "user", content: `问题 ${start + index}`, timestamp: NOW.getTime() },
    });
    entries.push({
      role: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `回答 ${start + index}` }],
        stopReason: "stop",
        timestamp: NOW.getTime(),
      },
    });
  }
  database.appendAgentTranscript(conversationId, entries, NOW);
}

function system(text: string): AgentMessage {
  return { role: "system", content: text, timestamp: NOW.getTime() };
}

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: NOW.getTime() };
}

function assistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: NOW.getTime(),
  } as AgentMessage;
}

function assistantToolCall(name: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name, arguments: {} }],
    stopReason: "toolUse",
    timestamp: NOW.getTime(),
  } as AgentMessage;
}

function toolResult(toolName: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: NOW.getTime(),
  } as AgentMessage;
}
