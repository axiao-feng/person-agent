import { obsidianUri } from "../../knowledge/open.js";
import { createIdeaNote } from "../../knowledge/vault.js";
import type { Route } from "../context.js";
import { ApiError, safeErrorMessage } from "../errors.js";
import { objectBody, optionalString, validation } from "../http.js";

export const ideaRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/api/ideas",
    async handler(request) {
      const body = objectBody(request.body);
      const content = body.body;
      if (typeof content !== "string" || !content.trim()) {
        throw validation("idea 正文不能为空。", "body", "idea 正文不能为空。");
      }
      if (content.length > 100_000) {
        throw validation("idea 正文不能超过 100000 个字符。", "body");
      }
      const title = optionalString(body, "title", "idea 标题", 200);
      const tags = parseTags(body.tags);
      try {
        const note = createIdeaNote(
          request.runtime.config.knowledgeVaultPath,
          {
            body: content,
            ...(title ? { title } : {}),
            ...(tags.length ? { tags } : {}),
          },
          request.now,
          request.runtime.config.timezone,
        );
        return {
          status: 201,
          body: {
            idea: {
              title: note.title,
              relativePath: note.relativePath,
              createdAt: note.created,
              tags: note.tags,
              openUrl: obsidianUri(note.path),
            },
          },
        };
      } catch (error) {
        throw new ApiError(
          503,
          "DEPENDENCY_UNAVAILABLE",
          `无法写入 Obsidian 知识库：${safeErrorMessage(error)}`,
          true,
        );
      }
    },
  },
];

function parseTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw validation("tags 必须是数组。", "tags", "tags 必须是数组。");
  if (value.length > 20) throw validation("标签不能超过 20 个。", "tags", "标签不能超过 20 个。");
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw validation("标签必须是非空文本。", "tags", "标签必须是非空文本。");
    }
    if (item.trim().length > 50) {
      throw validation("单个标签不能超过 50 个字符。", "tags", "单个标签不能超过 50 个字符。");
    }
    tags.push(item.trim());
  }
  return tags;
}
