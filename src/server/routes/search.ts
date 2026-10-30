import { obsidianUri } from "../../knowledge/open.js";
import { searchIdeas } from "../../knowledge/vault.js";
import type { Route } from "../context.js";
import { ApiError } from "../errors.js";
import { integerQuery } from "../http.js";
import type { SearchResult } from "../types.js";

const TYPES = ["paper", "task", "idea", "lecture"] as const;
type SearchType = (typeof TYPES)[number];

export const searchRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/search",
    async handler(request) {
      const query = request.query.get("q")?.trim() ?? "";
      if (!query) throw new ApiError(400, "BAD_REQUEST", "搜索词不能为空。");
      if (query.length > 200) throw new ApiError(400, "BAD_REQUEST", "搜索词不能超过 200 个字符。");
      const types = parseTypes(request.query.get("types"));
      const limit = integerQuery(request.query, "limit", 30, 1, 100);
      const needle = query.toLocaleLowerCase();
      const results: SearchResult[] = [];

      if (types.has("paper")) {
        for (const paper of request.database.listZoteroPapers()) {
          const haystack = [
            paper.title,
            paper.abstract ?? "",
            ...paper.tags,
            ...paper.creators.map(
              (creator) => creator.name || `${creator.firstName} ${creator.lastName}`.trim(),
            ),
          ]
            .join("\n")
            .toLocaleLowerCase();
          if (!haystack.includes(needle)) continue;
          results.push({
            type: "paper",
            id: paper.key,
            title: paper.title || "无标题",
            source: "Zotero",
            snippet: snippetAround(paper.abstract ?? "", needle, 160),
            openTarget: `paper:${paper.key}`,
          });
        }
      }

      if (types.has("task")) {
        for (const task of request.database.listResearchTasks()) {
          if (!task.title.toLocaleLowerCase().includes(needle)) continue;
          results.push({
            type: "task",
            id: task.id,
            title: task.title,
            source: "本地任务",
            snippet: `状态：${task.status}；预计 ${task.estimatedMinutes} 分钟`,
            openTarget: `task:${task.id}`,
          });
        }
      }

      if (types.has("idea")) {
        for (const idea of searchIdeas(request.runtime.config.knowledgeVaultPath, query, limit)) {
          results.push({
            type: "idea",
            id: idea.relativePath,
            title: idea.title,
            source: "Obsidian",
            snippet: idea.snippet || null,
            openTarget: obsidianUri(idea.path),
          });
        }
      }

      if (types.has("lecture")) {
        for (const lecture of request.database.listLectures()) {
          const haystack = [lecture.title, lecture.location ?? "", lecture.speaker ?? "", lecture.notes ?? ""]
            .join("\n")
            .toLocaleLowerCase();
          if (!haystack.includes(needle)) continue;
          results.push({
            type: "lecture",
            id: lecture.id,
            title: lecture.title,
            source: "本地讲座",
            snippet: [lecture.location, lecture.speaker].filter(Boolean).join(" · ") || null,
            openTarget: `lecture:${lecture.id}`,
          });
        }
      }

      return { body: { query, items: results.slice(0, limit) } };
    },
  },
];

function parseTypes(value: string | null): Set<SearchType> {
  if (!value) return new Set(TYPES);
  const types = new Set<SearchType>();
  for (const part of value.split(",")) {
    const normalized = part.trim();
    if (!normalized) continue;
    if (!TYPES.includes(normalized as SearchType)) {
      throw new ApiError(400, "BAD_REQUEST", `搜索类型无效：${normalized}`);
    }
    types.add(normalized as SearchType);
  }
  return types.size ? types : new Set(TYPES);
}

function snippetAround(text: string, needle: string, maximum: number): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const index = normalized.toLocaleLowerCase().indexOf(needle);
  if (index < 0) return normalized.slice(0, maximum);
  const start = Math.max(0, index - 50);
  const end = Math.min(normalized.length, index + needle.length + maximum - 50);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}
