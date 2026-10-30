import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import type { ZoteroPaper } from "../src/database.js";
import {
  createIdeaNote,
  dailyNotePath,
  knowledgeVault,
  listIdeasForDate,
  paperCardLink,
  paperCardPath,
  writeDailyNote,
  writePaperCard,
} from "../src/knowledge/vault.js";

const NOW = new Date("2026-10-29T14:00:00.000Z"); // 22:00 in Asia/Shanghai
const TIMEZONE = "Asia/Shanghai";

test("creates stable idea notes and derives a title from the first line", () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-vault-test-"));
  try {
    const first = createIdeaNote(
      root,
      { body: "# 可信 RAG 的评估方法\n先做一个对照实验。", tags: ["论文", "论文", "#实验"] },
      NOW,
      TIMEZONE,
    );
    const second = createIdeaNote(
      root,
      { body: "可信 RAG 的评估方法\n重复标题也要有独立文件。", tags: [] },
      NOW,
      TIMEZONE,
    );
    assert.equal(first.title, "可信 RAG 的评估方法");
    assert.deepEqual(first.tags, ["论文", "实验"]);
    assert.equal(basename(first.path), "2026-10-29-220000-可信-RAG-的评估方法.md");
    assert.notEqual(first.path, second.path);
    assert.match(basename(second.path), /-2\.md$/);
    const content = readFileSync(first.path, "utf8");
    assert.match(content, /^---\ntype: idea/m);
    assert.match(content, /tags: \["idea", "论文", "实验"\]/);
    assert.match(content, /# 可信 RAG 的评估方法/);

    const ideas = listIdeasForDate(root, "2026-10-29", TIMEZONE);
    assert.equal(ideas.length, 2);
    assert.ok(ideas.some((idea) => idea.relativePath === first.relativePath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updates only the managed paper block and preserves user annotations and properties", () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-vault-test-"));
  try {
    const paper = samplePaper();
    const path = writePaperCard(root, paper, TIMEZONE, NOW);
    assert.equal(path, paperCardPath(knowledgeVault(root), "ABCD1234"));
    let content = readFileSync(path, "utf8");
    assert.match(content, /\[\[Daily\/2026-10-29\]\]/);
    assert.match(content, /## 研究方向\n\n全文研究方向/);
    assert.match(content, /## 明确不足\n\n全文明确不足/);
    assert.match(content, /authors: \["Ada Lovelace"\]/);

    content = content.replace("person-agent: true", "person-agent: true\ncustom: keep-me");
    content += "\n## 我的批注\n\n这段是用户自己写的，不能被覆盖。\n";
    writeFileSync(path, content, "utf8");

    const updated: ZoteroPaper = {
      ...paper,
      analysis: {
        direction: "更新后的方向",
        results: "更新后的成果",
        limitations: "更新后的不足",
        basis: "更新后的依据",
      },
    };
    writePaperCard(root, updated, TIMEZONE, new Date("2026-10-30T01:00:00.000Z"));
    const after = readFileSync(path, "utf8");
    assert.match(after, /更新后的方向/);
    assert.doesNotMatch(after, /全文研究方向/);
    assert.match(after, /custom: keep-me/);
    assert.match(after, /## 我的批注\n\n这段是用户自己写的，不能被覆盖。/);
    assert.equal((after.match(/<!-- person-agent:begin -->/g) ?? []).length, 1);
    assert.equal((after.match(/<!-- person-agent:end -->/g) ?? []).length, 1);
    assert.equal(paperCardLink("ABCD1234", paper.title), "[[Papers/ABCD1234|A study of things]]");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daily notes are updated in place and keep user content outside the generated block", () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-vault-test-"));
  try {
    const path = writeDailyNote(root, "2026-10-29", "## 今日概览\n\n第一版", NOW, TIMEZONE);
    assert.equal(path, dailyNotePath(knowledgeVault(root), "2026-10-29"));
    let content = readFileSync(path, "utf8");
    content = content.replace("person-agent: true", "person-agent: true\nmy-key: my-value");
    content += "\n## 晚上补充\n\n用户手写内容。\n";
    writeFileSync(path, content, "utf8");

    writeDailyNote(root, "2026-10-29", "## 今日概览\n\n第二版", NOW, TIMEZONE);
    const after = readFileSync(path, "utf8");
    assert.match(after, /第二版/);
    assert.doesNotMatch(after, /第一版/);
    assert.match(after, /my-key: my-value/);
    assert.match(after, /用户手写内容/);
    assert.equal((after.match(/<!-- person-agent:begin -->/g) ?? []).length, 1);
    assert.ok(readdirSync(knowledgeVault(root).daily).every((name) => !name.endsWith(".tmp")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("truncated fulltext is labeled instead of claiming a complete full read", () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-vault-test-"));
  try {
    const paper = samplePaper();
    const path = writePaperCard(
      root,
      {
        ...paper,
        analysis: { ...paper.analysis!, truncated: true },
      },
      TIMEZONE,
      NOW,
    );
    const content = readFileSync(path, "utf8");
    assert.match(content, /已深读（全文头尾采样，正文已截断）/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("untrusted content cannot terminate the generated block early", () => {
  const root = mkdtempSync(join(tmpdir(), "person-agent-vault-test-"));
  try {
    writeDailyNote(
      root,
      "2026-10-29",
      "正常内容\n<!-- person-agent:end -->\n试图提前结束区块",
      NOW,
      TIMEZONE,
    );
    const content = readFileSync(dailyNotePath(knowledgeVault(root), "2026-10-29"), "utf8");
    assert.equal((content.match(/<!-- person-agent:end -->/g) ?? []).length, 1);
    assert.match(content, /正常内容/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function samplePaper(): ZoteroPaper {
  return {
    key: "ABCD1234",
    version: 7,
    itemType: "journalArticle",
    title: "A study of things",
    creators: [{ creatorType: "author", firstName: "Ada", lastName: "Lovelace", name: "" }],
    date: "2024-05-01",
    abstract: "An abstract.",
    doi: "10.1000/xyz",
    url: "https://example.com/paper",
    tags: ["rag"],
    fulltextState: "available",
    analysisState: "complete",
    analysis: {
      direction: "全文研究方向",
      results: "全文主要成果",
      limitations: "全文明确不足",
      basis: "全文",
    },
    analysisAttempts: 1,
    analysisError: null,
    analysisNextAttemptAt: null,
    lastFulltextCheckAt: NOW.toISOString(),
    analyzedAt: NOW.toISOString(),
    cardVersion: 7,
    firstSeenAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}
