import type { Route } from "../context.js";
import { integerQuery, notFound, validation } from "../http.js";
import { paperDetail, paperSummary } from "../paper-data.js";
import type { PaperSummary } from "../types.js";

export const paperRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/papers",
    async handler(request) {
      const stateText = request.query.get("state") ?? "";
      if (stateText && stateText !== "pending" && stateText !== "retrying" && stateText !== "partial" && stateText !== "complete") {
        throw validation("state 参数无效。", "state", "state 参数无效。");
      }
      const sort = request.query.get("sort") ?? "recent";
      if (sort !== "recent" && sort !== "title") {
        throw validation("sort 参数无效。", "sort", "sort 参数无效。");
      }
      const offset = integerQuery(request.query, "offset", 0, 0, 1_000_000);
      const limit = integerQuery(request.query, "limit", 50, 1, 100);
      const now = request.now;
      const summaries = request.database.listZoteroPapers().map((paper) => paperSummary(paper, now));
      const counts = {
        pending: summaries.filter((paper) => paper.evidenceState === "pending").length,
        retrying: summaries.filter((paper) => paper.evidenceState === "retrying").length,
        partial: summaries.filter((paper) => paper.evidenceState === "abstract_only").length,
        complete: summaries.filter(
          (paper) =>
            paper.evidenceState === "fulltext" || paper.evidenceState === "truncated_fulltext",
        ).length,
      };
      const filtered = stateText ? summaries.filter((paper) => matchesState(paper, stateText)) : summaries;
      filtered.sort(
        sort === "title"
          ? (left, right) => left.title.localeCompare(right.title, "zh-CN")
          : (left, right) => right.firstSeenAt.localeCompare(left.firstSeenAt) || left.title.localeCompare(right.title),
      );
      return {
        body: {
          items: filtered.slice(offset, offset + limit),
          offset,
          limit,
          total: filtered.length,
          counts,
        },
      };
    },
  },
  {
    method: "GET",
    pattern: "/api/papers/:paperKey",
    async handler(request) {
      const key = request.params.paperKey;
      if (!key) throw validation("缺少论文 key。", "paperKey");
      const paper = request.database.getZoteroPaper(key);
      if (!paper) throw notFound("找不到论文。");
      return { body: { paper: paperDetail(paper, request.runtime.config, request.now) } };
    },
  },
];

function matchesState(paper: PaperSummary, state: string): boolean {
  if (state === "partial") return paper.evidenceState === "abstract_only";
  if (state === "complete") {
    return paper.evidenceState === "fulltext" || paper.evidenceState === "truncated_fulltext";
  }
  return paper.evidenceState === state;
}
