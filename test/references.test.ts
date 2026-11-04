import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { collectAgentReferences } from "../src/agent/references.js";
import { AppDatabase } from "../src/database.js";

const NOW = new Date("2026-11-04T02:00:00.000Z");

test("references come only from structured tool results and are re-verified", () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-reference-test-"));
  const database = new AppDatabase(join(root, "test.db"));
  try {
    const task = database.createResearchTask({ title: "整理实验数据", estimatedMinutes: 60 }, NOW);
    const lecture = database.createLecture(
      { title: "组会", startAt: "2026-11-05T06:00:00.000Z", endAt: "2026-11-05T07:00:00.000Z" },
      NOW,
    );
    const action = database.stageWorkflowAction(
      "calendar.create",
      { title: "排期", startAt: "2026-11-06T01:00:00.000Z", endAt: "2026-11-06T02:00:00.000Z", taskId: task.id },
      NOW,
    );

    const messages: AgentMessage[] = [
      toolResult({
        references: [
          { type: "task", id: task.id, title: task.title },
          { type: "task", id: task.id, title: "重复的引用会被合并" },
          { type: "lecture", id: lecture.id, title: lecture.title },
          { type: "approval", id: action.id, title: "排期" },
        ],
      }),
      toolResult({
        references: [
          { type: "task", id: "missing-task", title: "编造的任务" },
          { type: "folder", id: "x", title: "未知类型" },
          { type: "task", id: "", title: "空 ID" },
        ],
      }),
    ];
    const references = collectAgentReferences({ database, messages });
    assert.deepEqual(
      references.map((reference) => `${reference.type}:${reference.id}`),
      [`task:${task.id}`, `lecture:${lecture.id}`, `approval:${action.id}`],
    );
    assert.equal(references[0]?.title, task.title, "the first verified title wins");

    // The model's own text never becomes a reference.
    const assistantOnly: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "任务 abc123 已经创建" }],
        stopReason: "stop",
        timestamp: NOW.getTime(),
      } as AgentMessage,
    ];
    assert.deepEqual(collectAgentReferences({ database, messages: assistantOnly }), []);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("idea references require an existing vault file", () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-reference-test-"));
  const database = new AppDatabase(join(root, "test.db"));
  const vault = join(root, "vault");
  mkdirSync(join(vault, "Ideas"), { recursive: true });
  writeFileSync(join(vault, "Ideas", "2026-11-04-note.md"), "# note\n", "utf8");
  try {
    const messages: AgentMessage[] = [
      toolResult({
        references: [
          { type: "idea", id: "Ideas/2026-11-04-note.md", title: "实验记录" },
          { type: "idea", id: "Ideas/not-there.md", title: "不存在的笔记" },
        ],
      }),
    ];
    assert.deepEqual(collectAgentReferences({ database, messages, vaultPath: vault }), [
      { type: "idea", id: "Ideas/2026-11-04-note.md", title: "实验记录" },
    ]);
    assert.deepEqual(
      collectAgentReferences({ database, messages }),
      [],
      "without a vault path, ideas cannot be verified and are dropped",
    );
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("references are capped and malformed entries are ignored", () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-reference-test-"));
  const database = new AppDatabase(join(root, "test.db"));
  try {
    const tasks = Array.from({ length: 25 }, (_, index) =>
      database.createResearchTask({ title: `任务 ${index}`, estimatedMinutes: 30 }, NOW),
    );
    const messages: AgentMessage[] = [
      toolResult({ references: tasks.map((task) => ({ type: "task", id: task.id, title: task.title })) }),
      toolResult({ references: "not-an-array" }),
      toolResult({ references: [null, 42, { type: "task" }] }),
    ];
    assert.equal(collectAgentReferences({ database, messages }).length, 20);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function toolResult(details: unknown): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "create_task",
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
    isError: false,
    timestamp: NOW.getTime(),
  } as AgentMessage;
}
