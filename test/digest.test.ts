import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AppConfig } from "../src/config.js";
import { AppDatabase } from "../src/database.js";
import type { TextGenerator } from "../src/knowledge/analysis.js";
import { generateKnowledgeDigest } from "../src/knowledge/digest.js";
import {
  createIdeaNote,
  ensureKnowledgeVault,
  knowledgeVault,
  paperCardPath,
} from "../src/knowledge/vault.js";
import type { ZoteroClient, ZoteroPage } from "../src/knowledge/zotero.js";
import { processDueJobs } from "../src/worker.js";

const NOW = new Date("2026-10-29T14:00:00.000Z"); // 22:00 in Asia/Shanghai
const TIMEZONE = "Asia/Shanghai";

test("a new Zotero paper and idea produce cross-linked cards and an idempotent daily note", async () => {
  await withEnvironment(async ({ database, config, root, paths }) => {
    const idea = createIdeaNote(
      config.knowledgeVaultPath,
      { title: "评估想法", body: "用对照实验验证检索质量。", tags: ["实验"] },
      NOW,
      TIMEZONE,
    );
    database.createResearchTask(
      { title: "完成数值分析作业", taskKind: "assignment", deadline: "2026-10-31T18:00:00+08:00" },
      NOW,
    );
    database.createLecture(
      { title: "可信人工智能讲座", startAt: "2026-11-05T19:00:00+08:00", location: "学术报告厅" },
      NOW,
    );
    const client = new SimpleClient();
    client.add("KEY00001", 1, "Retrieval evaluation", "We study retrieval.");
    client.fulltext.set("KEY00001", "Full paper text about retrieval evaluation.");
    client.libraryVersion = 1;
    const opened: string[] = [];
    const stages: string[] = [];
    const { generator } = digestGenerator();

    const first = await generateKnowledgeDigest(
      { paths, config, database },
      {
        now: NOW,
        client,
        textGenerator: generator,
        openNote: true,
        onStage: (stage) => stages.push(stage),
        onOpen: (path) => {
          opened.push(path);
          return { path, target: path, method: "system" };
        },
      },
    );
    assert.deepEqual(stages, ["syncing", "analyzing", "writing"]);
    assert.equal(first.date, "2026-10-29");
    assert.equal(first.degraded, false);
    assert.equal(first.opened, true);
    assert.equal(opened.length, 1);
    assert.ok(existsSync(first.notePath));

    const daily = readFileSync(first.notePath, "utf8");
    assert.match(daily, /## 今日概览/);
    assert.match(daily, /\[\[Papers\/KEY00001\|Retrieval evaluation\]\]/);
    assert.ok(daily.includes(`[[${idea.relativePath}|`));
    assert.match(daily, /完成数值分析作业/);
    assert.match(daily, /可信人工智能讲座/);
    assert.match(daily, /\[作业\]/);
    assert.equal((daily.match(/\[\[Papers\/KEY00001/g) ?? []).length, 1);

    const paperPath = paperCardPath(knowledgeVault(config.knowledgeVaultPath), "KEY00001");
    const paper = readFileSync(paperPath, "utf8");
    assert.match(paper, /\[\[Daily\/2026-10-29\]\]/);
    assert.match(paper, /## 研究方向\n\n研究方向/);
    assert.match(paper, /## 明确不足\n\n明确不足/);
    assert.match(paper, /已深读（全文）/);
    assert.equal(database.getZoteroPaper("KEY00001")?.analysisState, "complete");

    const annotation = "\n## 我的补充\n\n这段批注要保留。\n";
    writeFileSync(first.notePath, readFileSync(first.notePath, "utf8") + annotation, "utf8");
    writeFileSync(paperPath, readFileSync(paperPath, "utf8") + annotation, "utf8");

    const second = await generateKnowledgeDigest(
      { paths, config, database },
      {
        now: new Date(NOW.getTime() + 60_000),
        client,
        textGenerator: generator,
        openNote: true,
        onOpen: (path) => {
          opened.push(path);
          return { path, target: path, method: "system" };
        },
      },
    );
    const repeated = readFileSync(second.notePath, "utf8");
    assert.match(repeated, /这段批注要保留/);
    assert.equal((repeated.match(/<!-- person-agent:begin -->/g) ?? []).length, 1);
    assert.equal((repeated.match(/\[\[Papers\/KEY00001/g) ?? []).length, 1);
    assert.match(readFileSync(paperPath, "utf8"), /这段批注要保留/);
    assert.equal(opened.length, 2);
    assert.equal(second.analyzed.length, 0);
  });
});

test("a DeepSeek failure still writes a deterministic list digest", async () => {
  await withEnvironment(async ({ database, config, paths }) => {
    const idea = createIdeaNote(
      config.knowledgeVaultPath,
      { body: "记录一个不依赖模型的 idea。", tags: [] },
      NOW,
      TIMEZONE,
    );
    const client = new SimpleClient();
    const failing: TextGenerator = async () => {
      throw new Error("Connection error.");
    };
    const result = await generateKnowledgeDigest(
      { paths, config, database },
      { now: NOW, client, textGenerator: failing, openNote: false },
    );
    assert.equal(result.degraded, true);
    assert.equal(result.opened, false);
    const daily = readFileSync(result.notePath, "utf8");
    assert.match(daily, /今日暂无新增论文/);
    assert.ok(daily.includes(idea.relativePath));
    assert.doesNotMatch(daily, /## 今日概览/);
  });
});

test("an unavailable Zotero API degrades to a local digest instead of losing the day", async () => {
  await withEnvironment(async ({ database, config, paths }) => {
    const client: ZoteroClient = {
      listTopItems: async () => {
        throw new Error("无法连接 Zotero 本地 API。请确认 Zotero 已启动。");
      },
      getFulltext: async () => null,
    };
    const { generator } = digestGenerator();
    const result = await generateKnowledgeDigest(
      { paths, config, database },
      { now: NOW, client, textGenerator: generator, openNote: false },
    );
    assert.match(result.syncError ?? "", /Zotero/);
    const daily = readFileSync(result.notePath, "utf8");
    assert.match(daily, /Zotero 同步失败/);
    assert.match(daily, /今日暂无新增论文/);
  });
});

test("a failed digest is actually re-executed after the retry delay", async () => {
  await withEnvironment(async ({ database, config, paths }) => {
    database.ensureKnowledgeDigest(config, new Date("2026-10-29T10:00:00.000Z")); // 18:00 local
    const failedAt = new Date("2026-10-29T15:00:00.000Z"); // 23:00 local
    assert.equal(database.scheduleMissedKnowledgeDigest(config, failedAt), true);

    let failedCalls = 0;
    const delays: number[] = [];
    await processDueJobs(
      { paths, config, database, logger: () => undefined },
      {
        now: failedAt,
        knowledgeGenerator: async () => {
          failedCalls += 1;
          throw new Error("model unavailable");
        },
        notifier: async () => {
          throw new Error("failed digest must not notify");
        },
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
      },
    );
    assert.equal(failedCalls, 2);
    assert.deepEqual(delays, [60_000]);
    const failedRun = database.sqlite
      .prepare("SELECT status, attempts FROM job_runs WHERE job_id = ?")
      .get("knowledge-digest") as { status: string; attempts: number };
    assert.equal(failedRun.status, "failed");
    assert.equal(failedRun.attempts, 1);
    assert.equal(
      database.scheduleMissedKnowledgeDigest(config, new Date(failedAt.getTime() + 30 * 60_000)),
      false,
    );

    const retryAt = new Date(failedAt.getTime() + 61 * 60_000);
    assert.equal(database.scheduleMissedKnowledgeDigest(config, retryAt), true);
    let retriedCalls = 0;
    await processDueJobs(
      { paths, config, database, logger: () => undefined },
      {
        now: retryAt,
        knowledgeGenerator: async () => {
          retriedCalls += 1;
        },
        notifier: async () => {
          throw new Error("retried digest must not notify");
        },
        sleep: async () => undefined,
      },
    );
    assert.equal(retriedCalls, 1);
    const deliveredRun = database.sqlite
      .prepare("SELECT status, attempts FROM job_runs WHERE job_id = ?")
      .get("knowledge-digest") as { status: string; attempts: number };
    assert.equal(deliveredRun.status, "delivered");
    assert.equal(deliveredRun.attempts, 2);
    assert.equal(
      database.scheduleMissedKnowledgeDigest(config, new Date(retryAt.getTime() + 60_000)),
      false,
    );
  });
});

test("worker catches up a digest that is more than 12 hours late", async () => {
  await withEnvironment(async ({ database, config, paths }) => {
    database.ensureKnowledgeDigest(config, new Date("2026-10-29T10:00:00.000Z")); // 18:00 local
    const lateMorning = new Date("2026-10-30T03:00:00.000Z"); // 11:00 local, 12.5 hours late
    assert.equal(database.scheduleMissedKnowledgeDigest(config, lateMorning), true);
    let calls = 0;
    await processDueJobs(
      { paths, config, database, logger: () => undefined },
      {
        now: lateMorning,
        knowledgeGenerator: async (digestAt) => {
          calls += 1;
          assert.equal(digestAt.toISOString(), "2026-10-29T14:30:00.000Z");
        },
        notifier: async () => {
          throw new Error("catch-up must not send a second notification");
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(database.runCount("knowledge-digest"), 1);
    const row = database.sqlite
      .prepare("SELECT next_run_at FROM jobs WHERE id = ?")
      .get("knowledge-digest") as { next_run_at: string };
    assert.equal(row.next_run_at, "2026-10-30T14:30:00.000Z");
  });
});

test("worker schedules a missed digest backlog oldest-first", async () => {
  await withEnvironment(async ({ database, config, paths }) => {
    database.ensureKnowledgeDigest(config, new Date("2026-10-27T10:00:00.000Z")); // Oct 27 18:00 local
    const now = new Date("2026-10-30T03:00:00.000Z"); // Oct 30 11:00 local
    assert.equal(database.scheduleMissedKnowledgeDigest(config, now), true);
    let [job] = database.listDueJobs(now);
    assert.ok(job);
    assert.equal(job.nextRunAt, "2026-10-27T14:30:00.000Z");
    const firstRun = database.beginRun(job, job.nextRunAt!, now);
    assert.ok(firstRun);
    database.completeRun(firstRun, "delivered", null, now);
    database.advanceJob(job, job.nextRunAt!, now);

    assert.equal(database.scheduleMissedKnowledgeDigest(config, now), true);
    [job] = database.listDueJobs(now);
    assert.ok(job);
    assert.equal(job.nextRunAt, "2026-10-28T14:30:00.000Z");

    let calls = 0;
    await processDueJobs(
      { paths, config, database, logger: () => undefined },
      {
        now,
        knowledgeGenerator: async () => {
          calls += 1;
        },
        notifier: async () => {
          throw new Error("catch-up must not send a second notification");
        },
      },
    );
    assert.equal(calls, 1);
  });
});

test("worker catches up a missed 22:30 digest and retries one failure", async () => {
  await withEnvironment(async ({ database, config, paths }) => {
    const evening = new Date("2026-10-29T10:00:00.000Z"); // 18:00 local
    database.ensureKnowledgeDigest(config, evening);
    const late = new Date("2026-10-29T15:00:00.000Z"); // 23:00 local
    assert.equal(database.scheduleMissedKnowledgeDigest(config, late), true);
    let attempts = 0;
    const delays: number[] = [];
    await processDueJobs(
      { paths, config, database, logger: () => undefined },
      {
        now: late,
        knowledgeGenerator: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("temporary failure");
        },
        notifier: async () => {
          throw new Error("knowledge digest must not show a second notification");
        },
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
      },
    );
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [60_000]);
    assert.equal(database.runCount("knowledge-digest"), 1);
    assert.equal(database.listDueJobs(late).length, 0);
    assert.equal(database.scheduleMissedKnowledgeDigest(config, new Date(late.getTime() + 60_000)), false);
  });
});

class SimpleClient implements ZoteroClient {
  readonly items: Array<{ version: number; raw: unknown }> = [];
  readonly fulltext = new Map<string, string | null>();
  libraryVersion = 0;

  add(key: string, version: number, title: string, abstractNote: string): void {
    this.items.push({
      version,
      raw: {
        key,
        version,
        data: {
          key,
          version,
          itemType: "journalArticle",
          title,
          abstractNote,
          date: "2025",
          DOI: "10.1000/digest",
          creators: [{ creatorType: "author", firstName: "Grace", lastName: "Hopper" }],
          tags: [{ tag: "retrieval" }],
        },
      },
    });
  }

  async listTopItems(input: { since?: number; start: number; limit: number }): Promise<ZoteroPage> {
    const filtered = this.items
      .filter((item) => input.since === undefined || item.version > input.since)
      .sort((left, right) => left.version - right.version);
    return {
      items: filtered.slice(input.start, input.start + input.limit).map((item) => item.raw),
      libraryVersion: this.libraryVersion,
      totalResults: filtered.length,
    };
  }

  async getFulltext(key: string) {
    const text = this.fulltext.get(key);
    return text ? { text, truncated: false } : null;
  }
}

function digestGenerator(): { generator: TextGenerator } {
  return {
    generator: async (_system, prompt) => {
      if (prompt.startsWith("分析下面这篇论文")) {
        return JSON.stringify({
          direction: "研究方向",
          results: "主要成果",
          limitations: "明确不足",
          basis: "全文",
        });
      }
      return "今日新增论文、idea、作业和讲座已整理。";
    },
  };
}

async function withEnvironment(
  operation: (input: {
    database: AppDatabase;
    config: AppConfig;
    root: string;
    paths: ReturnType<typeof testPaths>;
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "person-agent-digest-test-"));
  const config: AppConfig = {
    timezone: TIMEZONE,
    briefingTime: "07:30",
    thinkingLevel: "low",
    knowledgeVaultPath: join(root, "vault"),
    knowledgeDigestTime: "22:30",
  };
  ensureKnowledgeVault(config.knowledgeVaultPath);
  const database = new AppDatabase(join(root, "test.db"));
  const paths = testPaths(root);
  try {
    await operation({ database, config, root, paths });
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function testPaths(root: string) {
  return {
    root,
    config: join(root, "config.json"),
    database: join(root, "test.db"),
    secrets: join(root, "secrets.dpapi"),
    log: join(root, "worker.log"),
  };
}
