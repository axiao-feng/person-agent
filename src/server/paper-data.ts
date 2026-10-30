import { existsSync } from "node:fs";

import type { AppConfig } from "../config.js";
import type { PaperAnalysis, ZoteroPaper } from "../database.js";
import { obsidianUri } from "../knowledge/open.js";
import { knowledgeVault, paperCardPath } from "../knowledge/vault.js";
import type { PaperEvidenceState, PaperSummary } from "./types.js";

export type PaperDetail = PaperSummary & {
  itemType: string;
  version: number;
  abstract: string | null;
  doi: string | null;
  sourceUrl: string | null;
  fulltextState: ZoteroPaper["fulltextState"];
  analysisState: ZoteroPaper["analysisState"];
  analysis: (PaperAnalysis & { truncated: boolean }) | null;
  analysisError: string | null;
  analyzedAt: string | null;
  links: {
    zotero: string;
    obsidian: string | null;
  };
};

export function deriveEvidenceState(paper: ZoteroPaper, now: Date): PaperEvidenceState {
  const retrying =
    paper.analysisState === "pending" &&
    Boolean(paper.analysisError) &&
    paper.analysisNextAttemptAt !== null &&
    Date.parse(paper.analysisNextAttemptAt) > now.getTime();
  if (paper.analysisState === "complete") {
    return paper.analysis?.truncated ? "truncated_fulltext" : "fulltext";
  }
  if (paper.analysisState === "partial") return "abstract_only";
  return retrying ? "retrying" : "pending";
}

export function paperSummary(paper: ZoteroPaper, now: Date): PaperSummary {
  const evidenceState = deriveEvidenceState(paper, now);
  return {
    key: paper.key,
    title: paper.title,
    creators: paper.creators
      .map((creator) =>
        creator.name.trim() || [creator.firstName, creator.lastName].filter(Boolean).join(" ").trim(),
      )
      .filter(Boolean),
    dateText: paper.date,
    tags: paper.tags,
    evidenceState,
    retryAt: evidenceState === "retrying" ? paper.analysisNextAttemptAt : null,
    firstSeenAt: paper.firstSeenAt,
    updatedAt: paper.updatedAt,
  };
}

export function paperDetail(paper: ZoteroPaper, config: AppConfig, now: Date): PaperDetail {
  const summary = paperSummary(paper, now);
  const cardPath = paperCardPath(knowledgeVault(config.knowledgeVaultPath), paper.key);
  return {
    ...summary,
    itemType: paper.itemType,
    version: paper.version,
    abstract: paper.abstract,
    doi: paper.doi,
    sourceUrl: paper.url,
    fulltextState: paper.fulltextState,
    analysisState: paper.analysisState,
    analysis: paper.analysis
      ? { ...paper.analysis, truncated: paper.analysis.truncated === true }
      : null,
    analysisError: paper.analysisError,
    analyzedAt: paper.analyzedAt,
    links: {
      zotero: `zotero://select/library/items/${encodeURIComponent(paper.key)}`,
      obsidian: existsSync(cardPath) ? obsidianUri(cardPath) : null,
    },
  };
}
