import type { AppConfig } from "../config.js";
import {
  AppDatabase,
  ZOTERO_LAST_SYNC_AT_KEY,
  ZOTERO_LIBRARY_VERSION_KEY,
  type ZoteroCreator,
  type ZoteroPaperMetadata,
} from "../database.js";
import type { Logger } from "../logger.js";
import { writePaperCard } from "./vault.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:23119/api/users/0";
const DEFAULT_LIMIT = 100;
const MAX_FULLTEXT_CHARACTERS = 60_000;
const FULLTEXT_HEAD_CHARACTERS = 40_000;
const FULLTEXT_TAIL_CHARACTERS = 20_000;
const FULLTEXT_OMISSION_MARKER = "[...中间内容因长度限制省略...]";

export type FulltextResult = {
  text: string;
  truncated: boolean;
};

export type ZoteroPage = {
  items: unknown[];
  libraryVersion: number;
  totalResults: number;
};

export type ZoteroClient = {
  listTopItems(input: { since?: number; start: number; limit: number }): Promise<ZoteroPage>;
  getFulltext(key: string): Promise<FulltextResult | null>;
};

export type ZoteroSyncContext = {
  config: AppConfig;
  database: AppDatabase;
  logger?: Logger;
};

export type ZoteroSyncOptions = {
  client?: ZoteroClient;
  now?: Date;
  pageSize?: number;
  fulltextRefreshLimit?: number;
};

export type ZoteroSyncResult = {
  added: number;
  updated: number;
  skipped: number;
  pages: number;
  cursor: number;
  fulltextPromoted: number;
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class HttpZoteroClient implements ZoteroClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly fulltextCache = new Map<string, FulltextResult | null>();

  constructor(options: { baseUrl?: string; fetchImpl?: FetchLike; timeoutMs?: number } = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async listTopItems(input: { since?: number; start: number; limit: number }): Promise<ZoteroPage> {
    const url = new URL(`${this.baseUrl}/items/top`);
    url.searchParams.set("limit", String(input.limit));
    url.searchParams.set("start", String(input.start));
    if (input.since && input.since > 0) url.searchParams.set("since", String(input.since));
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "Zotero-API-Version": "3",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(
        `无法连接 Zotero 本地 API（${this.baseUrl}）。请确认 Zotero 已启动并启用本地 API。${error instanceof Error ? ` ${error.message}` : ""}`,
      );
    }
    if (!response.ok) {
      throw new Error(`Zotero 本地 API 返回 HTTP ${response.status}。请确认 Zotero 已启动并允许本地 API 访问。`);
    }
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error("Zotero 本地 API 返回了非预期的条目列表。");
    return {
      items: body,
      libraryVersion: integerHeader(response.headers.get("Last-Modified-Version")),
      totalResults: integerHeader(response.headers.get("Total-Results")),
    };
  }

  async getFulltext(key: string): Promise<FulltextResult | null> {
    if (this.fulltextCache.has(key)) return this.fulltextCache.get(key) ?? null;
    const direct = await this.fetchFulltext(key);
    if (direct) {
      this.fulltextCache.set(key, direct);
      return direct;
    }
    // Zotero indexes full text per attachment. The parent item endpoint usually
    // returns 404, so resolve PDF children and read the first indexed attachment.
    const attachments = await this.listChildAttachments(key);
    for (const attachmentKey of attachments) {
      try {
        const content = await this.fetchFulltext(attachmentKey);
        if (content) {
          this.fulltextCache.set(key, content);
          return content;
        }
      } catch {
        // One unreadable attachment must not hide fulltext from another child.
      }
    }
    this.fulltextCache.set(key, null);
    return null;
  }

  private async fetchFulltext(key: string): Promise<FulltextResult | null> {
    const url = `${this.baseUrl}/items/${encodeURIComponent(key)}/fulltext`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: "application/json, text/plain" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(
        `无法从 Zotero 读取全文（${key}）。${error instanceof Error ? ` ${error.message}` : ""}`,
      );
    }
    if (response.status === 404 || response.status === 204) return null;
    if (!response.ok) throw new Error(`Zotero 全文接口返回 HTTP ${response.status}（${key}）。`);
    const text = await response.text();
    const content = parseFulltextBody(text, response.headers.get("Content-Type") ?? "");
    if (!content) return null;
    return limitFulltext(content);
  }

  private async listChildAttachments(key: string): Promise<string[]> {
    const url = `${this.baseUrl}/items/${encodeURIComponent(key)}/children`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: "application/json", "Zotero-API-Version": "3" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(
        `无法从 Zotero 读取附件（${key}）。${error instanceof Error ? ` ${error.message}` : ""}`,
      );
    }
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`Zotero 附件接口返回 HTTP ${response.status}（${key}）。`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) return [];
    const attachments: Array<{ key: string; pdf: boolean }> = [];
    for (const raw of body) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const data =
        item.data && typeof item.data === "object" ? (item.data as Record<string, unknown>) : item;
      if (stringValue(data.itemType) !== "attachment") continue;
      const childKey = stringValue(item.key) ?? stringValue(data.key);
      if (!childKey) continue;
      const contentType = stringValue(data.contentType) ?? "";
      const filename = stringValue(data.filename) ?? "";
      attachments.push({
        key: childKey,
        pdf: contentType.toLowerCase().includes("pdf") || filename.toLowerCase().endsWith(".pdf"),
      });
    }
    return attachments
      .sort((left, right) => Number(right.pdf) - Number(left.pdf))
      .slice(0, 10)
      .map((item) => item.key);
  }
}

export async function syncZotero(
  context: ZoteroSyncContext,
  options: ZoteroSyncOptions = {},
): Promise<ZoteroSyncResult> {
  const client = options.client ?? new HttpZoteroClient();
  const now = options.now ?? new Date();
  const pageSize = clampInteger(options.pageSize ?? DEFAULT_LIMIT, 1, DEFAULT_LIMIT);
  const cursor = parseCursor(context.database.getKnowledgeState(ZOTERO_LIBRARY_VERSION_KEY));
  const seen = new Set<string>();
  let start = 0;
  let pages = 0;
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let maxVersion = cursor;
  let libraryVersion = cursor;

  while (true) {
    const page = await client.listTopItems({
      ...(cursor > 0 ? { since: cursor } : {}),
      start,
      limit: pageSize,
    });
    libraryVersion = Math.max(libraryVersion, page.libraryVersion);
    for (const raw of page.items) {
      const metadata = parseZoteroItem(raw);
      if (!metadata) continue;
      if (seen.has(metadata.key)) {
        skipped += 1;
        continue;
      }
      seen.add(metadata.key);
      if (cursor > 0 && metadata.version > 0 && metadata.version <= cursor) {
        skipped += 1;
        continue;
      }
      const result = context.database.upsertZoteroPaper(metadata, now);
      if (result.changed) {
        if (result.paper.firstSeenAt === now.toISOString()) added += 1;
        else updated += 1;
      }
      if (result.paper.cardVersion !== result.paper.version) {
        writePaperCard(context.config.knowledgeVaultPath, result.paper, context.config.timezone, now);
        context.database.setZoteroCardVersion(result.paper.key, result.paper.version);
      }
      maxVersion = Math.max(maxVersion, metadata.version);
    }
    pages += 1;
    if (page.items.length === 0 || page.items.length < pageSize) break;
    start += page.items.length;
    if (pages >= 100) break;
  }

  // The cursor only advances after every metadata card has been written successfully.
  // A failed write leaves the previous cursor in place, so the whole page is retried.
  const nextCursor = Math.max(cursor, maxVersion, libraryVersion);
  context.database.setKnowledgeState(ZOTERO_LIBRARY_VERSION_KEY, String(nextCursor));
  context.database.setKnowledgeState(ZOTERO_LAST_SYNC_AT_KEY, now.toISOString());

  const fulltextPromoted = await refreshFulltextAvailability(
    context,
    client,
    now,
    options.fulltextRefreshLimit ?? 20,
  );
  return { added, updated, skipped, pages, cursor: nextCursor, fulltextPromoted };
}

export async function refreshFulltextAvailability(
  context: Pick<ZoteroSyncContext, "database" | "logger">,
  client: ZoteroClient,
  now: Date,
  limit = 20,
): Promise<number> {
  const checkedBefore = new Date(now.getTime() - 6 * 60 * 60_000);
  const papers = context.database.listZoteroPapersForFulltextCheck(checkedBefore, limit);
  let promoted = 0;
  for (const paper of papers) {
    let fulltext: FulltextResult | null;
    try {
      fulltext = await client.getFulltext(paper.key);
    } catch (error) {
      context.logger?.("zotero_fulltext_check_failed", {
        key: paper.key,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    context.database.setZoteroFulltextState(paper.key, fulltext ? "available" : "unavailable", now);
    if (fulltext) {
      context.database.setZoteroAnalysisPending(paper.key, now);
      promoted += 1;
    }
  }
  return promoted;
}

export function parseZoteroItem(raw: unknown): ZoteroPaperMetadata | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const top = raw as Record<string, unknown>;
  const data =
    top.data && typeof top.data === "object" ? (top.data as Record<string, unknown>) : top;
  const key = stringValue(top.key) ?? stringValue(data.key);
  const itemType = stringValue(data.itemType);
  if (!key || !itemType) return undefined;
  if (itemType === "note" || itemType === "attachment" || itemType === "annotation") return undefined;
  const title = stringValue(data.title) ?? "未命名条目";
  const creators: ZoteroCreator[] = [];
  if (Array.isArray(data.creators)) {
    for (const creator of data.creators) {
      if (!creator || typeof creator !== "object") continue;
      const item = creator as Record<string, unknown>;
      creators.push({
        creatorType: stringValue(item.creatorType) ?? "",
        firstName: stringValue(item.firstName) ?? "",
        lastName: stringValue(item.lastName) ?? "",
        name: stringValue(item.name) ?? "",
      });
    }
  }
  const tags: string[] = [];
  if (Array.isArray(data.tags)) {
    for (const tag of data.tags) {
      if (typeof tag === "string") tags.push(tag);
      else if (tag && typeof tag === "object") {
        const value = stringValue((tag as Record<string, unknown>).tag);
        if (value) tags.push(value);
      }
    }
  }
  return {
    key,
    version: integerValue(top.version) ?? integerValue(data.version) ?? 0,
    itemType,
    title,
    creators,
    date: stringValue(data.date) ?? null,
    abstract: stringValue(data.abstractNote) ?? null,
    doi: stringValue(data.DOI) ?? stringValue(data.doi) ?? null,
    url: stringValue(data.url) ?? null,
    tags,
  };
}

export function limitFulltext(text: string): FulltextResult {
  const normalized = text.trim();
  if (normalized.length <= MAX_FULLTEXT_CHARACTERS) {
    return { text: normalized, truncated: false };
  }
  const head = normalized.slice(0, FULLTEXT_HEAD_CHARACTERS);
  const tail = normalized.slice(-FULLTEXT_TAIL_CHARACTERS);
  return {
    text: `${head}\n\n${FULLTEXT_OMISSION_MARKER}\n\n${tail}`,
    truncated: true,
  };
}

function parseFulltextBody(text: string, contentType: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (contentType.includes("json") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const content = parsed.content;
      if (typeof content === "string") return content.trim() || null;
      if (Array.isArray(content)) {
        const joined = content.filter((part): part is string => typeof part === "string").join("\n").trim();
        return joined || null;
      }
      return null;
    } catch {
      return null;
    }
  }
  if (/^<!doctype html/i.test(trimmed) || /^<html/i.test(trimmed)) return null;
  return trimmed;
}

function integerHeader(value: string | null): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseCursor(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
