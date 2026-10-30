import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";

import type { PaperAnalysis, ZoteroPaper } from "../database.js";
import { localClockKey, localDateKey } from "../schedule.js";

export type KnowledgeVault = {
  root: string;
  ideas: string;
  papers: string;
  daily: string;
};

export type IdeaInput = {
  title?: string;
  body: string;
  tags?: string[];
};

export type IdeaNote = {
  title: string;
  path: string;
  relativePath: string;
  created: string;
  tags: string[];
};

export type IdeaSummary = {
  title: string;
  relativePath: string;
  created: string;
};

export type IdeaSearchItem = IdeaSummary & {
  path: string;
  snippet: string;
};

export const MANAGED_BLOCK_BEGIN = "<!-- person-agent:begin -->";
export const MANAGED_BLOCK_END = "<!-- person-agent:end -->";

export function knowledgeVault(vaultPath: string): KnowledgeVault {
  const root = vaultPath.trim();
  if (!root) throw new Error("知识库路径不能为空。");
  return {
    root,
    ideas: join(root, "Ideas"),
    papers: join(root, "Papers"),
    daily: join(root, "Daily"),
  };
}

export function ensureKnowledgeVault(vaultPath: string): KnowledgeVault {
  const vault = knowledgeVault(vaultPath);
  for (const directory of [vault.root, vault.ideas, vault.papers, vault.daily]) {
    mkdirSync(directory, { recursive: true });
  }
  return vault;
}

export function paperCardPath(vault: KnowledgeVault, zoteroKey: string): string {
  return join(vault.papers, `${safeFileComponent(zoteroKey, "paper")}.md`);
}

export function paperCardLink(zoteroKey: string, title: string): string {
  return `[[Papers/${safeFileComponent(zoteroKey, "paper")}|${wikiAlias(title)}]]`;
}

export function dailyNotePath(vault: KnowledgeVault, date: string): string {
  return join(vault.daily, `${date}.md`);
}

export function dailyNoteLink(date: string): string {
  return `[[Daily/${date}]]`;
}

export function ideaLink(relativePath: string, title: string): string {
  return `[[${relativePath}|${wikiAlias(title)}]]`;
}

export function createIdeaNote(
  vaultPath: string,
  input: IdeaInput,
  now: Date,
  timezone: string,
): IdeaNote {
  const vault = ensureKnowledgeVault(vaultPath);
  const body = normalizeBody(input.body);
  if (!body) throw new Error("idea 正文不能为空。");
  if (body.length > 100_000) throw new Error("idea 正文不能超过 100000 个字符。");
  const title = normalizeIdeaTitle(input.title, body);
  const tags = normalizeTags(input.tags ?? []);
  const created = now.toISOString();
  const date = localDateKey(now, timezone);
  const clock = localClockKey(now, timezone);
  const base = `${date}-${clock}-${slugify(title)}`;
  let path = join(vault.ideas, `${base}.md`);
  for (let suffix = 2; existsSync(path); suffix += 1) {
    path = join(vault.ideas, `${base}-${suffix}.md`);
  }
  const frontmatter = [
    "type: idea",
    `title: ${yamlString(title)}`,
    `created: ${yamlString(created)}`,
    `tags: ${yamlArray(["idea", ...tags])}`,
    "person-agent: true",
  ];
  const content = `---\n${frontmatter.join("\n")}\n---\n\n# ${title}\n\n${body}\n`;
  writeFileAtomic(path, content);
  return {
    title,
    path,
    relativePath: `Ideas/${basename(path, ".md")}`,
    created,
    tags,
  };
}

export function writePaperCard(
  vaultPath: string,
  paper: ZoteroPaper,
  timezone: string,
  now = new Date(),
): string {
  const vault = ensureKnowledgeVault(vaultPath);
  const path = paperCardPath(vault, paper.key);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const firstSeenDate = localDateKey(new Date(paper.firstSeenAt), timezone);
  const updatedDate = localDateKey(now, timezone);
  const year = yearFromDate(paper.date);
  const frontmatter = [
    "type: paper",
    `zotero-key: ${yamlString(paper.key)}`,
    `title: ${yamlString(paper.title)}`,
    `authors: ${yamlArray(paper.creators.map(creatorName))}`,
    ...(year ? [`year: ${year}`] : []),
    ...(paper.doi ? [`doi: ${yamlString(paper.doi)}`] : []),
    ...(paper.url ? [`url: ${yamlString(paper.url)}`] : []),
    `tags: ${yamlArray(["paper", ...paper.tags])}`,
    `created: ${yamlString(firstSeenDate)}`,
    `updated: ${yamlString(updatedDate)}`,
    "person-agent: true",
  ];
  const content = setManagedBlock(
    upsertFrontmatter(existing, frontmatter),
    renderPaperBlock(paper, firstSeenDate),
  );
  writeFileAtomic(path, content);
  return path;
}

export function writeDailyNote(
  vaultPath: string,
  date: string,
  managedBody: string,
  now = new Date(),
  timezone = "Asia/Shanghai",
): string {
  const vault = ensureKnowledgeVault(vaultPath);
  const path = dailyNotePath(vault, date);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const frontmatter = [
    "type: daily",
    `date: ${yamlString(date)}`,
    `created: ${yamlString(localDateKey(now, timezone))}`,
    "person-agent: true",
  ];
  const content = setManagedBlock(
    upsertFrontmatter(existing, frontmatter),
    `# ${date} 知识简报\n\n${managedBody.trim()}`,
  );
  writeFileAtomic(path, content);
  return path;
}

export function listIdeasForDate(vaultPath: string, date: string, timezone: string): IdeaSummary[] {
  const vault = knowledgeVault(vaultPath);
  if (!existsSync(vault.ideas)) return [];
  const ideas: IdeaSummary[] = [];
  for (const name of readdirSync(vault.ideas)) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    const path = join(vault.ideas, name);
    try {
      const content = readFileSync(path, "utf8");
      const properties = parseFrontmatter(content);
      const created = properties.created;
      let ideaDate: string | undefined;
      if (created) {
        const parsed = new Date(created);
        if (!Number.isNaN(parsed.getTime())) ideaDate = localDateKey(parsed, timezone);
      }
      if (!ideaDate) ideaDate = localDateKey(statSync(path).birthtime, timezone);
      if (ideaDate !== date) continue;
      const title = properties.title?.trim() || firstHeading(content) || basename(name, ".md");
      ideas.push({
        title,
        relativePath: `Ideas/${basename(name, ".md")}`,
        created: created ?? "",
      });
    } catch {
      // A locked or malformed note must not prevent the rest of the digest from being written.
    }
  }
  return ideas.sort((left, right) => left.created.localeCompare(right.created) || left.title.localeCompare(right.title));
}

export function searchIdeas(vaultPath: string, query: string, limit = 10): IdeaSearchItem[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const vault = knowledgeVault(vaultPath);
  if (!existsSync(vault.ideas)) return [];
  const results: IdeaSearchItem[] = [];
  for (const name of readdirSync(vault.ideas)) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    const path = join(vault.ideas, name);
    try {
      const content = readFileSync(path, "utf8");
      const properties = parseFrontmatter(content);
      const title = properties.title?.trim() || firstHeading(content) || basename(name, ".md");
      const body = content
        .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "")
        .replace(/<!--\s*person-agent:(?:begin|end)\s*-->/gi, "")
        .replace(/^#\s+.*$/m, "")
        .trim();
      if (!`${title}\n${body}`.toLocaleLowerCase().includes(needle)) continue;
      results.push({
        title,
        relativePath: `Ideas/${basename(name, ".md")}`,
        created: properties.created ?? "",
        path,
        snippet: excerpt(body, needle),
      });
    } catch {
      // A locked or malformed note must not break search.
    }
  }
  return results
    .sort((left, right) => right.created.localeCompare(left.created) || left.title.localeCompare(right.title))
    .slice(0, Math.max(0, Math.trunc(limit)));
}

export function setManagedBlock(content: string, managedBody: string): string {  // Untrusted paper text or model output must not be able to terminate the block.
  const safeBody = managedBody.replace(/<!--\s*person-agent:(?:begin|end)\s*-->/gi, "");
  const block = `${MANAGED_BLOCK_BEGIN}\n${safeBody.trim()}\n${MANAGED_BLOCK_END}`;
  const begin = content.indexOf(MANAGED_BLOCK_BEGIN);
  const end = begin >= 0 ? content.indexOf(MANAGED_BLOCK_END, begin + MANAGED_BLOCK_BEGIN.length) : -1;
  if (begin >= 0 && end >= 0) {
    return `${content.slice(0, begin)}${block}${content.slice(end + MANAGED_BLOCK_END.length)}`;
  }
  const trimmed = content.replace(/\s+$/, "");
  return `${trimmed}${trimmed ? "\n\n" : ""}${block}\n`;
}

export function upsertFrontmatter(markdown: string, managedLines: string[]): string {
  const normalized = markdown.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized);
  const managedKeys = new Set(managedLines.map(frontmatterKey).filter(Boolean));
  if (!match) {
    const body = normalized.replace(/^\s*\n/, "");
    return `---\n${managedLines.join("\n")}\n---\n${body ? `\n${body}` : ""}`;
  }
  const output: string[] = [];
  const used = new Set<string>();
  let skipContinuation = false;
  for (const line of match[1]!.split(/\r?\n/)) {
    const key = frontmatterKey(line);
    if (key && managedKeys.has(key)) {
      const replacement = managedLines.find((candidate) => frontmatterKey(candidate) === key);
      if (replacement && !used.has(key)) {
        output.push(replacement);
        used.add(key);
      }
      skipContinuation = true;
      continue;
    }
    if (key) skipContinuation = false;
    if (/^\s+/.test(line) && skipContinuation) continue;
    output.push(line);
  }
  for (const line of managedLines) {
    const key = frontmatterKey(line);
    if (key && !used.has(key)) output.push(line);
  }
  const body = normalized.slice(match[0].length);
  return `---\n${output.join("\n")}\n---\n${body ? (body.startsWith("\n") ? body : `\n${body}`) : ""}`;
}

export function parseFrontmatter(markdown: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown.replace(/^﻿/, ""));
  if (!match) return {};
  const properties: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const parsed = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!parsed?.[1]) continue;
    let value = parsed[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
      if (parsed[2]!.trim().startsWith('"')) {
        try {
          value = JSON.parse(parsed[2]!.trim()) as string;
        } catch {
          // Keep the unquoted value when it is not valid JSON.
        }
      }
    }
    properties[parsed[1]] = value;
  }
  return properties;
}

export function normalizeIdeaTitle(title: string | undefined, body: string): string {
  const explicit = title?.trim();
  if (explicit) {
    if (explicit.length > 200) throw new Error("idea 标题不能超过 200 个字符。");
    return explicit;
  }
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const derived = (firstLine ?? "未命名 idea").replace(/^#+\s*/, "").trim() || "未命名 idea";
  return derived.slice(0, 200);
}

function renderPaperBlock(paper: ZoteroPaper, firstSeenDate: string): string {
  const analysis = paper.analysis;
  const state = paper.analysisState;
  const authors = paper.creators.map(creatorName).filter(Boolean);
  const metadata = [
    `# ${paper.title}`,
    "",
    `- 作者：${authors.length ? authors.join("、") : "未知"}`,
    `- 年份：${yearFromDate(paper.date) ?? paper.date ?? "未知"}`,
    `- 类型：${paper.itemType}`,
    ...(paper.doi ? [`- DOI：[${paper.doi}](https://doi.org/${encodeURI(paper.doi)})`] : []),
    ...(paper.url ? [`- URL：${paper.url}`] : []),
    `- Zotero：[在 Zotero 中打开](zotero://select/library/items/${encodeURIComponent(paper.key)})`,
    `- 首次收录：${dailyNoteLink(firstSeenDate)}`,
    `- 分析状态：${analysisStateLabel(paper)}`,
  ];
  const sections = analysis
    ? [
        "## 研究方向",
        "",
        analysis.direction.trim() || "—",
        "",
        "## 主要成果",
        "",
        analysis.results.trim() || "—",
        "",
        "## 明确不足",
        "",
        analysis.limitations.trim() || "—",
        "",
        "## 分析依据",
        "",
        analysis.basis.trim() || "—",
      ]
    : [
        "## 研究方向",
        "",
        state === "pending" ? "待深度阅读（将在知识整理时完成）。" : "—",
        "",
        "## 主要成果",
        "",
        state === "pending" ? "待深度阅读（将在知识整理时完成）。" : "—",
        "",
        "## 明确不足",
        "",
        state === "pending" ? "待深度阅读。" : "—",
        "",
        "## 分析依据",
        "",
        paper.abstract ? "目前仅获取题录和摘要，尚未生成分析。" : "目前仅获取题录元数据。",
      ];
  return [...metadata, "", ...sections].join("\n");
}

function analysisStateLabel(paper: ZoteroPaper): string {
  if (paper.analysisState === "complete") {
    return paper.analysis?.truncated
      ? "已深读（全文头尾采样，正文已截断）"
      : "已深读（全文）";
  }
  if (paper.analysisState === "partial") {
    if (!paper.abstract) return "仅题录（证据有限）";
    return paper.fulltextState === "available" ? "摘要分析（全文待补全）" : "摘要分析（全文不可用，证据有限）";
  }
  return "待深读";
}

function creatorName(creator: { firstName: string; lastName: string; name: string }): string {
  return creator.name.trim() || `${creator.firstName} ${creator.lastName}`.trim();
}

function yearFromDate(value: string | null): string | undefined {
  return value?.match(/(?:19|20)\d{2}/)?.[0];
}

function firstHeading(content: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(content);
  return match?.[1]?.trim();
}

function excerpt(body: string, needle: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const index = normalized.toLocaleLowerCase().indexOf(needle);
  if (index < 0) return normalized.slice(0, 160);
  const start = Math.max(0, index - 60);
  const end = Math.min(normalized.length, index + needle.length + 100);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}

function writeFileAtomic(path: string, content: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "w");
    writeSync(descriptor, content, null, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The descriptor may already be closed.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not exist if the first write failed.
    }
    throw error;
  }
}

function frontmatterKey(line: string): string {
  return /^([A-Za-z0-9_-]+):/.exec(line)?.[1] ?? "";
}

function normalizeBody(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function normalizeTags(tags: string[]): string[] {
  const result: string[] = [];
  for (const tag of tags) {
    const normalized = tag.trim().replace(/^#/, "");
    if (!normalized || result.includes(normalized)) continue;
    if (normalized.length > 50) throw new Error("单个标签不能超过 50 个字符。");
    result.push(normalized);
    if (result.length >= 20) break;
  }
  return result;
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*#^[\]\u0000-\u001f]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .slice(0, 60);
  if (!slug) return "idea";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(slug)) return `idea-${slug}`;
  return slug;
}

function safeFileComponent(value: string, fallback: string): string {
  const safe = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "");
  return safe || fallback;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function wikiAlias(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

export type { PaperAnalysis };
