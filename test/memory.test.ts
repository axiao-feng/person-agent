import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AppDatabase } from "../src/database.js";
import { buildTools } from "../src/tools.js";

const NOW = new Date("2026-11-04T02:00:00.000Z");

test("memories deduplicate by normalized content and keep the higher importance", () => {
  withDatabase((database) => {
    const first = database.createAgentMemory(
      { kind: "preference", content: "  偏好 上午 阅读论文 ", sourceType: "explicit_user", importance: 3 },
      NOW,
    );
    assert.equal(first.created, true);
    assert.equal(first.memory.content, "偏好 上午 阅读论文");

    const duplicate = database.createAgentMemory(
      { kind: "preference", content: "偏好 上午 阅读论文", sourceType: "explicit_user", importance: 5 },
      NOW,
    );
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.memory.id, first.memory.id);
    assert.equal(duplicate.memory.importance, 5);
    assert.equal(database.listAgentMemories({ now: NOW }).length, 1);

    // Different kind is a different memory.
    const fact = database.createAgentMemory(
      { kind: "fact", content: "偏好 上午 阅读论文", sourceType: "explicit_user" },
      NOW,
    );
    assert.equal(fact.created, true);
    assert.equal(database.listAgentMemories({ now: NOW }).length, 2);
  });
});

test("memories are ordered by importance and filterable by kind and keyword", () => {
  withDatabase((database) => {
    database.createAgentMemory(
      { kind: "preference", content: "不喜欢周一上午安排会议", sourceType: "explicit_user", importance: 2 },
      NOW,
    );
    database.createAgentMemory(
      { kind: "fact", content: "导师是王老师", sourceType: "explicit_user", importance: 4 },
      NOW,
    );
    database.createAgentMemory(
      { kind: "preference", content: "论文阅读安排在上午", sourceType: "explicit_user", importance: 5 },
      NOW,
    );

    assert.deepEqual(
      database.listAgentMemories({ now: NOW }).map((memory) => memory.importance),
      [5, 4, 2],
    );
    assert.equal(database.listAgentMemories({ kind: "fact", now: NOW }).length, 1);
    assert.equal(database.listAgentMemories({ query: "上午", now: NOW }).length, 2);
    assert.equal(database.listAgentMemories({ limit: 1, now: NOW }).length, 1);
  });
});

test("expired and deleted memories never reach the prompt", () => {
  withDatabase((database) => {
    const expired = database.createAgentMemory(
      {
        kind: "experience",
        content: "这学期每周三有组会",
        sourceType: "conversation",
        validUntil: "2026-10-01T00:00:00.000Z",
      },
      NOW,
    );
    assert.equal(database.getAgentMemory(expired.memory.id)?.validUntil, "2026-10-01T00:00:00.000Z");
    assert.equal(database.listAgentMemories({ now: NOW }).length, 0);
    assert.equal(database.listAgentMemories({ now: new Date("2026-09-01T00:00:00.000Z") }).length, 1);

    const active = database.createAgentMemory(
      { kind: "preference", content: "写作放在下午", sourceType: "explicit_user" },
      NOW,
    );
    const deleted = database.deleteAgentMemory(active.memory.id, NOW);
    assert.ok(deleted.deletedAt);
    assert.equal(database.listAgentMemories({ now: NOW }).length, 0);
    assert.throws(() => database.updateAgentMemory(active.memory.id, { content: "改一下" }, NOW), /已删除/);
  });
});

test("memories can be edited and reject invalid values", () => {
  withDatabase((database) => {
    const created = database.createAgentMemory(
      { kind: "preference", content: "偏好上午阅读", sourceType: "explicit_user", importance: 2 },
      NOW,
    ).memory;
    const updated = database.updateAgentMemory(
      created.id,
      { content: "偏好上午阅读，下午写作", importance: 4, validUntil: null },
      NOW,
    );
    assert.equal(updated.content, "偏好上午阅读，下午写作");
    assert.equal(updated.importance, 4);
    assert.equal(updated.validUntil, null);

    assert.throws(
      () => database.createAgentMemory({ kind: "preference", content: "   ", sourceType: "explicit_user" }, NOW),
      /不能为空/,
    );
    assert.throws(
      () =>
        database.createAgentMemory(
          { kind: "preference", content: "合法内容", sourceType: "explicit_user", importance: 9 },
          NOW,
        ),
      /重要度/,
    );
    assert.throws(
      () =>
        database.createAgentMemory(
          { kind: "unknown" as never, content: "合法内容", sourceType: "explicit_user" },
          NOW,
        ),
      /类型无效/,
    );
  });
});

test("the remember_user_fact tool persists an explicit memory only in chat mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-memory-tool-test-"));
  const database = new AppDatabase(join(root, "test.db"));
  const paths = {
    root,
    config: join(root, "config.json"),
    database: join(root, "test.db"),
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
  try {
    const tools = buildTools({ paths, config, database });
    const tool = tools.find((candidate) => candidate.name === "remember_user_fact");
    assert.ok(tool, "chat mode exposes the memory tool");
    const result = await tool.execute("call-1", {
      kind: "preference",
      content: "偏好上午阅读论文",
      importance: 4,
    });
    const details = result.details as { created: boolean; memory: { id: string } };
    assert.equal(details.created, true);
    assert.equal(database.listAgentMemories({ now: NOW }).length, 1);
    assert.equal(database.getAgentMemory(details.memory.id)?.sourceType, "explicit_user");

    assert.equal(buildTools({ paths, config, database }, "briefing").length, 0);
    assert.equal(buildTools({ paths, config, database }, "knowledge").length, 0);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function withDatabase(operation: (database: AppDatabase) => void): void {
  const root = mkdtempSync(join(tmpdir(), "person-agent-memory-test-"));
  const database = new AppDatabase(join(root, "test.db"));
  try {
    operation(database);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}
