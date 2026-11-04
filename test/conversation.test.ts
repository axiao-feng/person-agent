import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

import {
  AgentUnavailableError,
  ConversationArchivedError,
  conversationTitleFrom,
  loadConversationHistory,
  runConversationTurn,
  type CreateConversationAgent,
} from "../src/agent/session.js";
import { contextTransform } from "../src/agent/context.js";
import { AppDatabase } from "../src/database.js";
import { buildTools } from "../src/tools.js";

const NOW = new Date("2026-11-04T02:00:00.000Z");

test("two turns share one conversation and a restarted process resumes it", async () => {
  await withConversationHarness(async (harness) => {
    harness.faux.setResponses([fauxAssistantMessage(fauxText("第一轮回答"))]);
    const first = await runConversationTurn({
      database: harness.database,
      message: "帮我安排今天的阅读",
      createAgent: harness.createAgent,
      now: NOW,
    });
    assert.equal(first.answer, "第一轮回答");
    assert.equal(first.conversation.title, "帮我安排今天的阅读");
    assert.equal(first.conversation.messageCount, 2);
    assert.deepEqual(first.messages.map((message) => message.role), ["user", "assistant"]);

    harness.faux.setResponses([fauxAssistantMessage(fauxText("第二轮回答"))]);
    const second = await runConversationTurn({
      database: harness.database,
      conversationId: first.conversation.id,
      message: "把刚才的结论再压缩一下",
      createAgent: harness.createAgent,
      now: NOW,
    });
    assert.equal(second.conversation.id, first.conversation.id);
    assert.equal(second.conversation.messageCount, 4);
    assert.equal(harness.histories[1]?.length, 2, "the second turn replays the first turn");
    assert.deepEqual(
      harness.histories[1]?.map((message) => message.role),
      ["user", "assistant"],
    );

    // A new process only shares the SQLite file: no in-memory state survives.
    harness.database.close();
    const reopened = new AppDatabase(harness.databasePath);
    try {
      harness.faux.setResponses([fauxAssistantMessage(fauxText("第三轮回答"))]);
      const third = await runConversationTurn({
        database: reopened,
        conversationId: first.conversation.id,
        message: "继续",
        createAgent: harness.createAgent,
        now: NOW,
      });
      assert.equal(third.answer, "第三轮回答");
      assert.equal(third.conversation.messageCount, 6);
      assert.equal(harness.histories.at(-1)?.length, 4, "restart replays the stored transcript");
      assert.equal(
        harness.histories.at(-1)?.at(-1)?.role,
        "assistant",
      );
    } finally {
      reopened.close();
      // withConversationHarness still owns cleanup of the closed original handle.
    }
  });
});

test("assistant tool calls and tool results round-trip through SQLite", async () => {
  await withConversationHarness(async (harness) => {
    harness.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("create_lecture", {
          title: "可信人工智能",
          startAt: "2026-11-05T11:00:00+08:00",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("已录入讲座。")),
    ]);
    const turn = await runConversationTurn({
      database: harness.database,
      message: "帮我录入 11 月 5 日晚上 7 点的可信人工智能讲座",
      createAgent: harness.createAgent,
      now: NOW,
    });
    assert.equal(turn.answer, "已录入讲座。");
    assert.equal(harness.database.listLectures().length, 1);

    const stored = harness.database.listAgentTranscript(turn.conversation.id);
    assert.deepEqual(
      stored.map((entry) => entry.role),
      ["user", "assistant", "toolResult", "assistant"],
    );
    assert.equal(stored[1]?.schemaVersion, 1);

    const history = loadConversationHistory(harness.database, turn.conversation.id);
    assert.deepEqual(
      history.map((message) => message.role),
      ["user", "assistant", "toolResult", "assistant"],
    );
    const call = toolCallOf(history[1]);
    assert.equal(call.name, "create_lecture");
    const result = history[2];
    assert.equal(result?.role, "toolResult");
    if (result?.role !== "toolResult") throw new Error("expected a stored tool result");
    assert.equal(result.toolCallId, call.id);
    assert.equal(result.isError, false);
    assert.equal(result.toolName, "create_lecture");
  });
});

test("an unanswered tool call at the tail is dropped before the next prompt", async () => {
  await withConversationHarness(async (harness) => {
    const conversation = harness.database.createAgentConversation("遗留会话", NOW);
    harness.database.appendAgentTranscript(
      conversation.id,
      [
        { role: "user", message: { role: "user", content: "随便做点什么", timestamp: NOW.getTime() } },
        {
          role: "assistant",
          message: {
            role: "assistant",
            content: [fauxToolCall("list_tasks", {})],
            stopReason: "toolUse",
            timestamp: NOW.getTime(),
          },
        },
      ],
      NOW,
    );
    assert.deepEqual(
      loadConversationHistory(harness.database, conversation.id).map((message) => message.role),
      ["user"],
    );

    harness.faux.setResponses([fauxAssistantMessage(fauxText("好的"))]);
    const turn = await runConversationTurn({
      database: harness.database,
      conversationId: conversation.id,
      message: "重新开始",
      createAgent: harness.createAgent,
      now: NOW,
    });
    assert.equal(turn.answer, "好的");
    assert.deepEqual(
      harness.histories.at(-1)?.map((message) => message.role),
      ["user"],
      "the dangling tool call is not replayed to the model",
    );
  });
});

test("a failed model turn is stored as an error and never returns an old answer", async () => {
  await withConversationHarness(async (harness) => {
    harness.faux.setResponses([fauxAssistantMessage(fauxText("第一轮回答"))]);
    const first = await runConversationTurn({
      database: harness.database,
      message: "第一问",
      createAgent: harness.createAgent,
      now: NOW,
    });

    harness.faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "model unavailable" }),
    ]);
    await assert.rejects(
      runConversationTurn({
        database: harness.database,
        conversationId: first.conversation.id,
        message: "第二问",
        createAgent: harness.createAgent,
        now: NOW,
      }),
      AgentUnavailableError,
    );

    const stored = harness.database.listAgentTranscript(first.conversation.id);
    assert.deepEqual(
      stored.map((entry) => entry.role),
      ["user", "assistant", "user", "assistant"],
    );
    const failed = stored.at(-1)?.message as { stopReason?: string };
    assert.equal(failed.stopReason, "error");
  });
});

test("archived conversations reject new turns and deleted ones drop their messages", async () => {
  await withConversationHarness(async (harness) => {
    harness.faux.setResponses([fauxAssistantMessage(fauxText("收到"))]);
    const turn = await runConversationTurn({
      database: harness.database,
      message: "先聊一句",
      createAgent: harness.createAgent,
      now: NOW,
    });

    harness.database.updateAgentConversation(turn.conversation.id, { status: "archived" }, NOW);
    await assert.rejects(
      runConversationTurn({
        database: harness.database,
        conversationId: turn.conversation.id,
        message: "还能继续吗",
        createAgent: harness.createAgent,
        now: NOW,
      }),
      ConversationArchivedError,
    );

    assert.equal(harness.database.deleteAgentConversation(turn.conversation.id), true);
    assert.equal(harness.database.getAgentConversation(turn.conversation.id), undefined);
    const row = harness.database.sqlite
      .prepare("SELECT COUNT(*) AS total FROM agent_messages WHERE conversation_id = ?")
      .get(turn.conversation.id) as { total: number };
    assert.equal(Number(row.total), 0);
    assert.equal(harness.database.deleteAgentConversation(turn.conversation.id), false);
  });
});

test("conversation titles come from the first message and stay bounded", () => {
  assert.equal(conversationTitleFrom("  帮我  看看今天的邮件 "), "帮我 看看今天的邮件");
  const long = conversationTitleFrom("组织".repeat(60));
  assert.equal(long.endsWith("…"), true);
  assert.equal(long.length <= 40, true);
});

test("a long conversation is trimmed to budget and the earlier part is summarized", async () => {
  await withConversationHarness(async (harness) => {
    const conversation = harness.database.createAgentConversation("长会话", NOW);
    appendPairs(harness.database, conversation.id, 20); // 40 stored messages

    harness.faux.setResponses([fauxAssistantMessage(fauxText("收到"))]);
    const turn = await runConversationTurn({
      database: harness.database,
      conversationId: conversation.id,
      message: "继续推进",
      createAgent: harness.createAgent,
      now: NOW,
      budgetTokens: 300,
      summary: { generate: async () => ({ summary: "前段摘要", openQuestions: ["还没确定时间"] }) },
    });

    assert.equal(turn.answer, "收到");
    assert.ok(turn.context, "every model request reports a context manifest");
    assert.ok(turn.context!.droppedMessages > 0, "the budget forces older messages out");
    assert.equal(turn.context!.summaryId, null, "the first turn had no summary to inject yet");
    assert.ok(turn.summaryId, "a summary is created after the backlog passes the threshold");

    const summary = harness.database.getActiveAgentSummary(conversation.id);
    assert.equal(summary?.fromSequence, 1);
    assert.equal(summary?.toSequence, 42 - 10);
    assert.equal(harness.database.countAgentMessages(conversation.id), 42, "raw messages are never deleted");

    harness.faux.setResponses([fauxAssistantMessage(fauxText("第二轮"))]);
    const second = await runConversationTurn({
      database: harness.database,
      conversationId: conversation.id,
      message: "再问一句",
      createAgent: harness.createAgent,
      now: NOW,
      budgetTokens: 300,
      summary: { generate: async () => ({ summary: "不该生成", openQuestions: [] }) },
    });
    assert.equal(second.context?.summaryId, turn.summaryId, "the next request injects the stored summary");
    const request = harness.requests.at(-1) ?? [];
    const systemMessages = request.filter((message) => message.role === "system");
    assert.ok(systemMessages.length >= 2, "system rules plus the summary are both present");
    assert.match(String(systemMessages.at(-1)?.content), /较早对话摘要/);
    assert.equal(harness.database.listAgentSummaries(conversation.id).length, 1);
  });
});

test("a failing summary never fails the turn", async () => {
  await withConversationHarness(async (harness) => {
    const conversation = harness.database.createAgentConversation("摘要失败", NOW);
    appendPairs(harness.database, conversation.id, 20);
    harness.faux.setResponses([fauxAssistantMessage(fauxText("照常回答"))]);
    const errors: unknown[] = [];
    const turn = await runConversationTurn({
      database: harness.database,
      conversationId: conversation.id,
      message: "继续",
      createAgent: harness.createAgent,
      now: NOW,
      summary: {
        generate: async () => {
          throw new Error("model unavailable");
        },
        onError: (error) => errors.push(error),
      },
    });
    assert.equal(turn.answer, "照常回答");
    assert.equal(turn.summaryId, null);
    assert.equal(errors.length, 1);
    assert.equal(harness.database.getActiveAgentSummary(conversation.id), undefined);
  });
});

type Harness = {
  database: AppDatabase;
  databasePath: string;
  faux: ReturnType<typeof fauxProvider>;
  createAgent: CreateConversationAgent;
  histories: AgentMessage[][];
  /** Messages actually handed to the model, after the Context Builder ran. */
  requests: AgentMessage[][];
};

async function withConversationHarness(operation: (harness: Harness) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "person-agent-conversation-test-"));
  const databasePath = join(root, "test.db");
  const database = new AppDatabase(databasePath);
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const paths = {
    root,
    config: join(root, "config.json"),
    database: databasePath,
    secrets: join(root, "secrets.dpapi"),
    log: join(root, "worker.log"),
  };
  const config = {
    timezone: "Asia/Shanghai",
    briefingTime: "07:30",
    thinkingLevel: "low" as const,
    knowledgeVaultPath: join(root, "vault"),
    knowledgeDigestTime: "22:30",
  };
  const histories: AgentMessage[][] = [];
  const requests: AgentMessage[][] = [];
  const createAgent: CreateConversationAgent = async (history, _conversationId, context) => {
    histories.push(history);
    const transform = contextTransform({
      context,
      budgetTokens: context.budgetTokens ?? 100_000,
      toolTokens: 0,
    });
    return new Agent({
      initialState: {
        systemPrompt: "时间不明确时追问。",
        model: faux.getModel(),
        thinkingLevel: "off",
        tools: buildTools({ paths, config, database }),
        ...(history.length > 0 ? { messages: history } : {}),
      },
      transformContext: async (messages: AgentMessage[]) => {
        const built = await transform(messages);
        requests.push(built);
        return built;
      },
      streamFn: models.streamSimple.bind(models),
    });
  };
  const harness: Harness = {
    database,
    databasePath,
    faux,
    createAgent,
    histories,
    requests,
  };
  try {
    await operation(harness);
  } finally {
    try {
      database.close();
    } catch {
      // A test may already have closed the handle before reopening the same file.
    }
    rmSync(root, { recursive: true, force: true });
  }
}

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

function toolCallOf(message: AgentMessage | undefined): { id: string; name: string } {  if (message?.role !== "assistant") throw new Error("expected an assistant message");
  const call = message.content.find(
    (block): block is Extract<(typeof message.content)[number], { type: "toolCall" }> =>
      block.type === "toolCall",
  );
  if (!call) throw new Error("expected a stored tool call");
  return { id: call.id, name: call.name };
}
