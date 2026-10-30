import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AppConfig } from "../src/config.js";
import { AppDatabase, ZOTERO_LIBRARY_VERSION_KEY } from "../src/database.js";
import {
  EVIDENCE_INSUFFICIENT,
  parsePaperAnalysis,
  type TextGenerator,
} from "../src/knowledge/analysis.js";
import { generateKnowledgeDigest } from "../src/knowledge/digest.js";
import { ensureKnowledgeVault, knowledgeVault, paperCardPath } from "../src/knowledge/vault.js";
import {
  HttpZoteroClient,
  limitFulltext,
  parseZoteroItem,
  syncZotero,
  type ZoteroClient,
  type ZoteroPage,
} from "../src/knowledge/zotero.js";

const NOW = new Date("2026-10-29T14:00:00.000Z");

test("parses Zotero top-level metadata and skips attachments and notes", () => {
  const parsed = parseZoteroItem(rawPaper("ABCD1234", 3, "论文标题", "摘要"));
  assert.ok(parsed);
  assert.equal(parsed.key, "ABCD1234");
  assert.equal(parsed.version, 3);
  assert.equal(parsed.title, "论文标题");
  assert.equal(parsed.abstract, "摘要");
  assert.equal(parsed.creators[0]?.lastName, "Lovelace");
  assert.deepEqual(parsed.tags, ["rag"]);
  assert.equal(parseZoteroItem({ key: "N1", version: 1, data: { itemType: "note", title: "note" } }), undefined);
  assert.equal(parseZoteroItem({ key: "A1", version: 1, data: { itemType: "attachment", title: "pdf" } }), undefined);
});

test("HTTP client sends read-only pagination parameters and reads indexed fulltext", async () => {
  const requested: string[] = [];
  const client = new HttpZoteroClient({
    baseUrl: "http://127.0.0.1:9/api/users/0",
    fetchImpl: async (input, init) => {
      const url = String(input);
      assert.equal(init?.method ?? "GET", "GET");
      requested.push(url);
      if (url.includes("/fulltext")) {
        return new Response(JSON.stringify({ content: "indexed full text" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify([{ key: "A" }]), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Last-Modified-Version": "42",
          "Total-Results": "1",
        },
      });
    },
  });
  const page = await client.listTopItems({ since: 5, start: 10, limit: 20 });
  assert.equal(page.libraryVersion, 42);
  assert.equal(page.totalResults, 1);
  assert.match(requested[0]!, /\/items\/top\?/);
  assert.match(requested[0]!, /since=5/);
  assert.match(requested[0]!, /start=10/);
  assert.match(requested[0]!, /limit=20/);
  assert.equal((await client.getFulltext("ABCD1234"))?.text, "indexed full text");
});

test("HTTP client resolves indexed fulltext from PDF attachment children", async () => {
  const requested: string[] = [];
  const client = new HttpZoteroClient({
    baseUrl: "http://127.0.0.1:9/api/users/0",
    fetchImpl: async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/items/PARENT/fulltext")) return new Response("Not found", { status: 404 });
      if (url.endsWith("/items/PARENT/children")) {
        return new Response(
          JSON.stringify([
            {
              key: "PDFCHILD",
              data: { itemType: "attachment", contentType: "application/pdf", filename: "paper.pdf" },
            },
          ]),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/items/PDFCHILD/fulltext")) {
        return new Response(JSON.stringify({ content: "fulltext from PDF attachment" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  assert.equal((await client.getFulltext("PARENT"))?.text, "fulltext from PDF attachment");
  assert.ok(requested.some((url) => url.includes("/items/PARENT/children")));
  assert.ok(requested.some((url) => url.includes("/items/PDFCHILD/fulltext")));
});

test("HTTP client reports an unavailable local API and missing fulltext", async () => {
  const offline = new HttpZoteroClient({
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  await assert.rejects(
    () => offline.listTopItems({ start: 0, limit: 1 }),
    /无法连接 Zotero 本地 API/,
  );

  const missing = new HttpZoteroClient({
    fetchImpl: async () => new Response("", { status: 404 }),
  });
  assert.equal(await missing.getFulltext("NOPE"), null);
});

test("sync paginates, deduplicates, and advances the version cursor only after writing cards", async () => {
  await withKnowledge(async ({ database, config, root }) => {
    const client = new FakeZoteroClient();
    client.add("A", 1, "Paper A");
    client.add("B", 2, "Paper B");
    client.add("C", 3, "Paper C");
    client.libraryVersion = 10;
    const first = await syncZotero({ config, database }, { client, now: NOW, pageSize: 2 });
    assert.equal(first.added, 3);
    assert.equal(first.pages, 2);
    assert.equal(first.cursor, 10);
    assert.equal(database.getKnowledgeState(ZOTERO_LIBRARY_VERSION_KEY), "10");
    for (const key of ["A", "B", "C"]) {
      assert.ok(existsSync(paperCardPath(knowledgeVault(config.knowledgeVaultPath), key)));
    }

    client.add("D", 11, "Paper D");
    client.libraryVersion = 11;
    const second = await syncZotero({ config, database }, { client, now: NOW, pageSize: 2 });
    assert.equal(second.added, 1);
    assert.equal(second.cursor, 11);
    assert.equal(database.listZoteroPapers().length, 4);

    const third = await syncZotero({ config, database }, { client, now: NOW, pageSize: 2 });
    assert.equal(third.added, 0);
    assert.equal(third.updated, 0);
    assert.equal(database.listZoteroPapers().length, 4);

    const duplicate = new FakeZoteroClient();
    duplicate.add("A", 1, "Paper A");
    duplicate.add("A", 1, "Paper A duplicate");
    duplicate.libraryVersion = 1;
    const dedupeDb = new AppDatabase(join(root, "dedupe.db"));
    try {
      const deduplicated = await syncZotero(
        { config, database: dedupeDb },
        { client: duplicate, now: NOW, pageSize: 10 },
      );
      assert.equal(deduplicated.added, 1);
      assert.equal(deduplicated.skipped, 1);
    } finally {
      dedupeDb.close();
    }
  });
});

test("a failed card write leaves the cursor unchanged and is retried", async () => {
  await withKnowledge(async ({ database, config }) => {
    const vault = ensureKnowledgeVault(config.knowledgeVaultPath);
    mkdirSync(join(vault.papers, "BAD.md"));
    const client = new FakeZoteroClient();
    client.add("GOOD", 1, "Good paper");
    client.add("BAD", 2, "Bad paper");
    client.libraryVersion = 2;
    await assert.rejects(
      () => syncZotero({ config, database }, { client, now: NOW, pageSize: 10 }),
      /EISDIR|EPERM|EACCES|illegal operation/i,
    );
    assert.equal(database.getKnowledgeState(ZOTERO_LIBRARY_VERSION_KEY), undefined);
    assert.ok(existsSync(paperCardPath(vault, "GOOD")));
    assert.equal(database.getZoteroPaper("BAD")?.cardVersion, -1);

    rmSync(join(vault.papers, "BAD.md"), { recursive: true, force: true });
    const retried = await syncZotero({ config, database }, { client, now: NOW, pageSize: 10 });
    assert.equal(retried.cursor, 2);
    assert.ok(existsSync(paperCardPath(vault, "BAD")));
    assert.equal(database.getZoteroPaper("BAD")?.cardVersion, 2);
  });
});

test("deep reads stop at five per day and abstract-only cards state insufficient evidence", async () => {
  await withKnowledge(async ({ database, config }) => {
    const client = new FakeZoteroClient();
    for (let index = 1; index <= 7; index += 1) {
      database.upsertZoteroPaper(
        parsedPaper(`P${index}`, index, `Paper ${index}`, `Abstract ${index}`),
        NOW,
      );
    }
    client.fulltext.set("P1", "full text for P1");
    const context = {
      paths: testPaths(config.knowledgeVaultPath),
      config,
      database,
    };
    const { generator, prompts } = analysisGenerator();
    const first = await generateKnowledgeDigest(context, {
      now: NOW,
      client,
      textGenerator: generator,
      sync: false,
      openNote: false,
    });
    assert.equal(first.analyzed.length, 5);
    assert.equal(prompts.filter((prompt) => prompt.startsWith("分析下面这篇论文")).length, 5);
    assert.equal(database.getZoteroPaper("P1")?.analysisState, "complete");
    assert.equal(database.getZoteroPaper("P2")?.analysisState, "partial");
    assert.equal(database.getZoteroPaper("P2")?.analysis?.limitations, EVIDENCE_INSUFFICIENT);
    assert.equal(database.getZoteroPaper("P6")?.analysisState, "pending");
    assert.equal(database.getZoteroPaper("P7")?.analysisState, "pending");

    const again = await generateKnowledgeDigest(context, {
      now: new Date(NOW.getTime() + 60_000),
      client,
      textGenerator: generator,
      sync: false,
      openNote: false,
    });
    assert.equal(again.analyzed.length, 0);
    assert.equal(prompts.filter((prompt) => prompt.startsWith("分析下面这篇论文")).length, 5);

    // The next day, fulltext is now indexed for P2; sync detects it and re-reads P2.
    client.fulltext.set("P2", "new full text for P2");
    client.libraryVersion = 0;
    const nextDay = await generateKnowledgeDigest(context, {
      now: new Date(NOW.getTime() + 24 * 60 * 60_000),
      client,
      textGenerator: generator,
      sync: true,
      openNote: false,
    });
    assert.equal(database.getZoteroPaper("P2")?.analysisState, "complete");
    assert.ok(nextDay.analyzed.includes("P2"));
    assert.ok(
      prompts.some((prompt) => prompt.startsWith("分析下面这篇论文") && prompt.includes("new full text for P2")),
    );
  });
});

test("fulltext request failures back off so later new papers still enter the queue", async () => {
  await withKnowledge(async ({ database, config }) => {
    for (let index = 1; index <= 6; index += 1) {
      database.upsertZoteroPaper(
        parsedPaper(`P${index}`, index, `Paper ${index}`, `Abstract ${index}`),
        NOW,
      );
    }
    const client = new FakeZoteroClient();
    for (let index = 1; index <= 5; index += 1) {
      client.fulltextFailures.add(`P${index}`);
    }
    const context = {
      paths: testPaths(config.knowledgeVaultPath),
      config,
      database,
    };
    const { generator, prompts } = analysisGenerator();
    const first = await generateKnowledgeDigest(context, {
      now: NOW,
      client,
      textGenerator: generator,
      sync: false,
      openNote: false,
    });
    assert.equal(first.analyzed.length, 0);
    assert.equal(first.analysisFailed.length, 5);
    for (let index = 1; index <= 5; index += 1) {
      const paper = database.getZoteroPaper(`P${index}`);
      assert.equal(paper?.analysisAttempts, 1);
      assert.equal(
        paper?.analysisNextAttemptAt,
        new Date(NOW.getTime() + 60 * 60_000).toISOString(),
      );
    }

    const second = await generateKnowledgeDigest(context, {
      now: new Date(NOW.getTime() + 60_000),
      client,
      textGenerator: generator,
      sync: false,
      openNote: false,
    });
    assert.deepEqual(second.analyzed, ["P6"]);
    assert.equal(database.getZoteroPaper("P6")?.analysisState, "partial");
    assert.equal(prompts.filter((prompt) => prompt.startsWith("分析下面这篇论文")).length, 1);
  });
});

test("failed analyses back off and new papers keep most of the daily budget", async () => {
  await withKnowledge(async ({ database }) => {
    for (let index = 1; index <= 5; index += 1) {
      const paper = database.upsertZoteroPaper(
        parsedPaper(`FAIL${index}`, index, `Failing ${index}`, `Abstract ${index}`),
        NOW,
      ).paper;
      database.recordZoteroAnalysisFailure(paper.key, "temporary failure", NOW);
      assert.equal(
        database.getZoteroPaper(paper.key)?.analysisNextAttemptAt,
        new Date(NOW.getTime() + 60 * 60_000).toISOString(),
      );
    }
    assert.equal(
      database.listZoteroPapersForAnalysis(5, new Date(NOW.getTime() + 30 * 60_000)).length,
      0,
    );

    const eligibleAt = new Date(NOW.getTime() + 2 * 60 * 60_000);
    assert.equal(database.listZoteroPapersForAnalysis(5, eligibleAt).length, 5);

    database.upsertZoteroPaper(parsedPaper("NEW00001", 6, "New paper", "New abstract"), NOW);
    const selected = database.listZoteroPapersForAnalysis(5, eligibleAt);
    assert.equal(selected.length, 5);
    assert.ok(selected.some((paper) => paper.key === "NEW00001"));
    assert.equal(selected.filter((paper) => paper.key.startsWith("FAIL")).length, 4);
  });
});

test("a truncated fulltext analysis records the sampling limitation in its basis", () => {
  const analysis = parsePaperAnalysis(
    JSON.stringify({
      direction: "方向",
      results: "成果",
      limitations: "不足",
      basis: "全文",
    }),
    true,
    true,
  );
  assert.equal(analysis.truncated, true);
  assert.match(analysis.basis, /头尾采样/);
  assert.match(analysis.basis, /中间内容省略/);
});

test("long fulltext is sampled from the head and tail instead of silently truncated", () => {
  const text = `${"开头".repeat(30_000)}${"结尾".repeat(15_000)}`;
  const result = limitFulltext(text);
  assert.equal(result.truncated, true);
  assert.ok(result.text.startsWith("开头"));
  assert.ok(result.text.endsWith("结尾"));
  assert.match(result.text, /中间内容因长度限制省略/);
});

function rawPaper(key: string, version: number, title: string, abstractNote = ""): unknown {
  return {
    key,
    version,
    data: {
      key,
      version,
      itemType: "journalArticle",
      title,
      abstractNote,
      date: "2024",
      DOI: "10.1000/test",
      creators: [{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" }],
      tags: [{ tag: "rag" }],
    },
  };
}

function parsedPaper(key: string, version: number, title: string, abstractNote: string) {
  const parsed = parseZoteroItem(rawPaper(key, version, title, abstractNote));
  assert.ok(parsed);
  return parsed;
}

function analysisGenerator(): { generator: TextGenerator; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    generator: async (_system, prompt) => {
      prompts.push(prompt);
      if (prompt.startsWith("分析下面这篇论文")) {
        return JSON.stringify({
          direction: "研究方向",
          results: "主要成果",
          limitations: "明确不足",
          basis: "分析依据",
        });
      }
      return "今日概览：论文与 idea 已整理。";
    },
  };
}

class FakeZoteroClient implements ZoteroClient {
  readonly items: Array<{ version: number; raw: unknown }> = [];
  readonly fulltext = new Map<string, string | null>();
  readonly fulltextFailures = new Set<string>();
  libraryVersion = 0;
  fail: Error | undefined;

  add(key: string, version: number, title: string, abstractNote = "abstract"): void {
    this.items.push({ version, raw: rawPaper(key, version, title, abstractNote) });
  }

  async listTopItems(input: { since?: number; start: number; limit: number }): Promise<ZoteroPage> {
    if (this.fail) throw this.fail;
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
    if (this.fail) throw this.fail;
    if (this.fulltextFailures.has(key)) throw new Error("fulltext endpoint unavailable");
    const text = this.fulltext.get(key);
    return text ? { text, truncated: false } : null;
  }
}

function testPaths(vault: string) {
  return {
    root: join(vault, ".app"),
    config: join(vault, ".app", "config.json"),
    database: join(vault, ".app", "agent.db"),
    secrets: join(vault, ".app", "secrets.dpapi"),
    log: join(vault, ".app", "worker.log"),
  };
}

async function withKnowledge(
  operation: (input: { database: AppDatabase; config: AppConfig; root: string }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "person-agent-zotero-test-"));
  const config: AppConfig = {
    timezone: "Asia/Shanghai",
    briefingTime: "07:30",
    thinkingLevel: "low",
    knowledgeVaultPath: join(root, "vault"),
    knowledgeDigestTime: "22:30",
  };
  ensureKnowledgeVault(config.knowledgeVaultPath);
  const database = new AppDatabase(join(root, "test.db"));
  try {
    await operation({ database, config, root });
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}
