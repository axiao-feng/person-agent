import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import type { AppConfig } from "./config.js";
import { briefingEnabled, knowledgeDigestEnabled } from "./config.js";
import { localDayRange, nextOccurrence, parseInstant, type JobSchedule, validateSchedule } from "./schedule.js";

export type Lecture = {
  id: string;
  title: string;
  startAt: string;
  endAt: string | null;
  location: string | null;
  speaker: string | null;
  notes: string | null;
  requiresPresentation: boolean;
  status: "active" | "cancelled";
  createdAt: string;
  updatedAt: string;
};

export type LectureInput = {
  title: string;
  startAt: string;
  endAt?: string;
  location?: string;
  speaker?: string;
  notes?: string;
  requiresPresentation?: boolean;
};

export type ReminderInput = {
  title: string;
  body?: string;
  schedule: JobSchedule;
  timezone: string;
};

export type ScheduledJob = {
  id: string;
  kind: "reminder" | "lecture" | "briefing";
  sourceId: string | null;
  title: string;
  body: string;
  schedule: JobSchedule;
  timezone: string;
  nextRunAt: string | null;
  enabled: boolean;
  catchupMinutes: number;
};

export type JobRunStatus = "claimed" | "delivered" | "failed" | "skipped";

export type JobRun = {
  id: string;
  jobId: string;
  scheduledFor: string;
  status: JobRunStatus;
  attempts: number;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type OperationKind = "knowledge.sync" | "knowledge.digest";
export type OperationStatus = "queued" | "running" | "succeeded" | "failed";

export type Operation = {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  stage: string | null;
  progressCurrent: number | null;
  progressTotal: number | null;
  result: unknown;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type OperationStart = {
  operation: Operation;
  created: boolean;
  busy: boolean;
};

export const OPERATION_STALE_MINUTES = 120;

export type ResearchTaskStatus = "draft" | "planned" | "in_progress" | "needs_replan" | "completed" | "cancelled";

export type TaskKind = "research" | "assignment" | "other";

export type ResearchTask = {
  id: string;
  title: string;
  taskKind: TaskKind;
  sourceType: "manual" | "email";
  sourceId: string | null;
  deadline: string | null;
  estimatedMinutes: number;
  priority: "low" | "medium" | "high";
  status: ResearchTaskStatus;
  confidence: number;
  plannedStart: string | null;
  plannedEnd: string | null;
  calendarEventId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ResearchTaskInput = {
  title: string;
  taskKind?: TaskKind;
  sourceType?: ResearchTask["sourceType"];
  sourceId?: string;
  deadline?: string;
  estimatedMinutes?: number;
  priority?: ResearchTask["priority"];
  confidence?: number;
};

export type ZoteroCreator = {
  creatorType: string;
  firstName: string;
  lastName: string;
  name: string;
};

export type ZoteroPaperMetadata = {
  key: string;
  version: number;
  itemType: string;
  title: string;
  creators: ZoteroCreator[];
  date: string | null;
  abstract: string | null;
  doi: string | null;
  url: string | null;
  tags: string[];
};

export type PaperAnalysis = {
  direction: string;
  results: string;
  limitations: string;
  basis: string;
  truncated?: boolean;
};

export type ZoteroFulltextState = "unknown" | "available" | "unavailable";
export type ZoteroAnalysisState = "pending" | "partial" | "complete";

export type ZoteroPaper = ZoteroPaperMetadata & {
  fulltextState: ZoteroFulltextState;
  analysisState: ZoteroAnalysisState;
  analysis: PaperAnalysis | null;
  analysisAttempts: number;
  analysisError: string | null;
  analysisNextAttemptAt: string | null;
  lastFulltextCheckAt: string | null;
  analyzedAt: string | null;
  cardVersion: number;
  firstSeenAt: string;
  updatedAt: string;
};

export const KNOWLEDGE_DIGEST_JOB_ID = "knowledge-digest";
export const KNOWLEDGE_DIGEST_CATCHUP_MINUTES = 7 * 24 * 60;
export const KNOWLEDGE_DIGEST_LOOKBACK_DAYS = 7;
export const ZOTERO_LIBRARY_VERSION_KEY = "zotero.libraryVersion";
export const ZOTERO_LAST_SYNC_AT_KEY = "zotero.lastSyncAt";

export type WorkflowActionKind = "calendar.create" | "calendar.update";
export type WorkflowActionStatus = "pending" | "approved" | "executing" | "executed" | "failed" | "rejected";

export type WorkflowAction = {
  id: string;
  kind: WorkflowActionKind;
  payload: Record<string, unknown>;
  status: WorkflowActionStatus;
  result: unknown;
  error: string | null;
  createdAt: string;
  approvedAt: string | null;
  executedAt: string | null;
};

type Row = Record<string, SQLOutputValue>;

export class AppDatabase {
  readonly sqlite: DatabaseSync;

  constructor(path: string) {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.sqlite.close();
  }

  createLecture(input: LectureInput, now = new Date()): Lecture {
    const normalized = normalizeLectureInput(input);
    const id = randomUUID();
    const timestamp = now.toISOString();
    this.transaction(() => {
      this.sqlite
        .prepare(
          `INSERT INTO lectures
           (id, title, start_at, end_at, location, speaker, notes, requires_presentation,
            status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          id,
          normalized.title,
          normalized.startAt,
          normalized.endAt ?? null,
          normalized.location ?? null,
          normalized.speaker ?? null,
          normalized.notes ?? null,
          normalized.requiresPresentation ? 1 : 0,
          timestamp,
          timestamp,
        );
      this.createLectureJobs(id, normalized.title, normalized.startAt, normalized.requiresPresentation ?? false, now);
    });
    return this.getLectureRequired(id);
  }

  updateLecture(id: string, patch: Partial<LectureInput>, now = new Date()): Lecture {
    const current = this.getLectureRequired(id);
    if (current.status === "cancelled") throw new Error("已取消的讲座不能修改。");
    const normalized = normalizeLectureInput({
      title: patch.title ?? current.title,
      startAt: patch.startAt ?? current.startAt,
      ...(patch.endAt !== undefined ? { endAt: patch.endAt } : current.endAt ? { endAt: current.endAt } : {}),
      ...(patch.location !== undefined
        ? { location: patch.location }
        : current.location
          ? { location: current.location }
          : {}),
      ...(patch.speaker !== undefined ? { speaker: patch.speaker } : current.speaker ? { speaker: current.speaker } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : current.notes ? { notes: current.notes } : {}),
      requiresPresentation: patch.requiresPresentation ?? current.requiresPresentation,
    });
    this.transaction(() => {
      this.sqlite
        .prepare(
          `UPDATE lectures SET title = ?, start_at = ?, end_at = ?, location = ?, speaker = ?,
           notes = ?, requires_presentation = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          normalized.title,
          normalized.startAt,
          normalized.endAt ?? null,
          normalized.location ?? null,
          normalized.speaker ?? null,
          normalized.notes ?? null,
          normalized.requiresPresentation ? 1 : 0,
          now.toISOString(),
          id,
        );
      this.disableLectureJobs(id, now);
      this.createLectureJobs(id, normalized.title, normalized.startAt, normalized.requiresPresentation ?? false, now);
    });
    return this.getLectureRequired(id);
  }

  cancelLecture(id: string, now = new Date()): Lecture {
    this.getLectureRequired(id);
    this.transaction(() => {
      this.sqlite
        .prepare("UPDATE lectures SET status = 'cancelled', updated_at = ? WHERE id = ?")
        .run(now.toISOString(), id);
      this.disableLectureJobs(id, now);
    });
    return this.getLectureRequired(id);
  }

  listLectures(from?: Date, to?: Date): Lecture[] {
    const clauses = ["status = 'active'"];
    const params: string[] = [];
    if (from) {
      clauses.push("start_at >= ?");
      params.push(from.toISOString());
    }
    if (to) {
      clauses.push("start_at < ?");
      params.push(to.toISOString());
    }
    return (
      this.sqlite
        .prepare(`SELECT * FROM lectures WHERE ${clauses.join(" AND ")} ORDER BY start_at`)
        .all(...params) as Row[]
    ).map(parseLecture);
  }

  getLecture(id: string): Lecture | undefined {
    const row = this.sqlite.prepare("SELECT * FROM lectures WHERE id = ?").get(id) as Row | undefined;
    return row ? parseLecture(row) : undefined;
  }

  listLecturesCreatedBetween(from: Date, to: Date): Lecture[] {
    return (
      this.sqlite
        .prepare("SELECT * FROM lectures WHERE created_at >= ? AND created_at < ? ORDER BY created_at")
        .all(from.toISOString(), to.toISOString()) as Row[]
    ).map(parseLecture);
  }

  createReminder(input: ReminderInput, now = new Date()): ScheduledJob {
    const title = requiredText(input.title, "提醒标题", 200);
    validateSchedule(input.schedule);
    assertTimezone(input.timezone);
    const next = nextOccurrence(input.schedule, new Date(now.getTime() - 1000), input.timezone);
    if (!next) throw new Error("提醒时间必须晚于当前时间。");
    const id = randomUUID();
    this.insertJob({
      id,
      kind: "reminder",
      sourceId: null,
      title,
      body: optionalText(input.body, 2_000) ?? "",
      schedule: input.schedule,
      timezone: input.timezone,
      nextRunAt: next,
      catchupMinutes: 360,
      now,
    });
    return this.getJobRequired(id);
  }

  listReminders(): ScheduledJob[] {
    return (this.sqlite.prepare("SELECT * FROM jobs WHERE kind = 'reminder' ORDER BY enabled DESC, next_run_at").all() as Row[]).map(
      parseJob,
    );
  }

  cancelReminder(id: string, now = new Date()): ScheduledJob {
    const job = this.getJobRequired(id);
    if (job.kind !== "reminder") throw new Error("该 ID 不是通用提醒。");
    this.sqlite.prepare("UPDATE jobs SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ?").run(now.toISOString(), id);
    return this.getJobRequired(id);
  }

  createResearchTask(input: ResearchTaskInput, now = new Date()): ResearchTask {
    const normalized = normalizeResearchTaskInput(input);
    const id = randomUUID();
    const timestamp = now.toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO research_tasks
         (id, title, task_kind, source_type, source_id, deadline, estimated_minutes, priority, status,
          confidence, planned_start, planned_end, calendar_event_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        normalized.title,
        normalized.taskKind,
        normalized.sourceType,
        normalized.sourceId ?? null,
        normalized.deadline ?? null,
        normalized.estimatedMinutes,
        normalized.priority,
        normalized.confidence,
        timestamp,
        timestamp,
      );
    return this.getResearchTaskRequired(id);
  }

  updateResearchTask(
    id: string,
    patch: {
      title?: string;
      taskKind?: TaskKind;
      sourceId?: string;
      deadline?: string | null;
      estimatedMinutes?: number;
      priority?: ResearchTask["priority"];
      confidence?: number;
      status?: ResearchTaskStatus;
      plannedStart?: string | null;
      plannedEnd?: string | null;
      calendarEventId?: string | null;
    },
    now = new Date(),
  ): ResearchTask {
    const current = this.getResearchTaskRequired(id);
    const normalized = normalizeResearchTaskInput({
      title: patch.title ?? current.title,
      taskKind: patch.taskKind ?? current.taskKind,
      sourceType: current.sourceType,
      ...(patch.sourceId !== undefined ? { sourceId: patch.sourceId } : current.sourceId ? { sourceId: current.sourceId } : {}),
      ...(patch.deadline === null
        ? {}
        : patch.deadline !== undefined
          ? { deadline: patch.deadline }
          : current.deadline
            ? { deadline: current.deadline }
            : {}),
      estimatedMinutes: patch.estimatedMinutes ?? current.estimatedMinutes,
      priority: patch.priority ?? current.priority,
      confidence: patch.confidence ?? current.confidence,
    });
    const status = patch.status ?? current.status;
    const statuses: ResearchTaskStatus[] = ["draft", "planned", "in_progress", "needs_replan", "completed", "cancelled"];
    if (!statuses.includes(status)) throw new Error("任务状态无效。");
    const plannedStart = patch.plannedStart === undefined ? current.plannedStart : normalizeOptionalInstant(patch.plannedStart);
    const plannedEnd = patch.plannedEnd === undefined ? current.plannedEnd : normalizeOptionalInstant(patch.plannedEnd);
    if ((plannedStart === null) !== (plannedEnd === null)) throw new Error("计划开始和结束时间必须同时提供或同时清空。");
    if (plannedStart && plannedEnd && Date.parse(plannedEnd) <= Date.parse(plannedStart)) {
      throw new Error("计划结束时间必须晚于开始时间。");
    }
    const calendarEventId = patch.calendarEventId === undefined
      ? current.calendarEventId
      : optionalText(patch.calendarEventId ?? undefined, 1_000) ?? null;
    if (status === "planned" && (!plannedStart || !plannedEnd || !calendarEventId)) {
      throw new Error("已计划任务必须同时关联计划时间和 Calendar 事件。");
    }
    this.sqlite
      .prepare(
        `UPDATE research_tasks SET title = ?, task_kind = ?, source_id = ?, deadline = ?, estimated_minutes = ?,
         priority = ?, status = ?, confidence = ?, planned_start = ?, planned_end = ?,
         calendar_event_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        normalized.title,
        normalized.taskKind,
        normalized.sourceId ?? null,
        normalized.deadline ?? null,
        normalized.estimatedMinutes,
        normalized.priority,
        status,
        normalized.confidence,
        plannedStart,
        plannedEnd,
        calendarEventId,
        now.toISOString(),
        id,
      );
    return this.getResearchTaskRequired(id);
  }

  listResearchTasks(status?: ResearchTaskStatus): ResearchTask[] {
    const rows = status
      ? this.sqlite.prepare("SELECT * FROM research_tasks WHERE status = ? ORDER BY deadline, created_at").all(status)
      : this.sqlite.prepare("SELECT * FROM research_tasks ORDER BY status, deadline, created_at").all();
    return (rows as Row[]).map(parseResearchTask);
  }

  getResearchTask(id: string): ResearchTask | undefined {
    const row = this.sqlite.prepare("SELECT * FROM research_tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? parseResearchTask(row) : undefined;
  }

  listResearchTasksCreatedBetween(from: Date, to: Date): ResearchTask[] {
    return (
      this.sqlite
        .prepare("SELECT * FROM research_tasks WHERE created_at >= ? AND created_at < ? ORDER BY created_at")
        .all(from.toISOString(), to.toISOString()) as Row[]
    ).map(parseResearchTask);
  }

  upsertZoteroPaper(input: ZoteroPaperMetadata, now = new Date()): { paper: ZoteroPaper; changed: boolean } {
    const normalized = normalizeZoteroPaperMetadata(input);
    const existing = this.getZoteroPaper(normalized.key);
    if (existing) {
      if (normalized.version < existing.version) return { paper: existing, changed: false };
      if (normalized.version === existing.version) return { paper: existing, changed: false };
      const metadataChanged =
        normalized.title !== existing.title ||
        normalized.abstract !== existing.abstract ||
        normalized.doi !== existing.doi ||
        normalized.date !== existing.date;
      this.sqlite
        .prepare(
          `UPDATE zotero_items SET version = ?, item_type = ?, title = ?, creators_json = ?,
           date_text = ?, abstract = ?, doi = ?, url = ?, tags_json = ?, updated_at = ?,
           analysis_state = CASE WHEN ? = 1 THEN 'pending' ELSE analysis_state END,
           analysis_json = CASE WHEN ? = 1 THEN NULL ELSE analysis_json END,
           analyzed_at = CASE WHEN ? = 1 THEN NULL ELSE analyzed_at END,
           analysis_error = CASE WHEN ? = 1 THEN NULL ELSE analysis_error END,
           analysis_next_attempt_at = CASE WHEN ? = 1 THEN NULL ELSE analysis_next_attempt_at END
           WHERE item_key = ?`,
        )
        .run(
          normalized.version,
          normalized.itemType,
          normalized.title,
          JSON.stringify(normalized.creators),
          normalized.date,
          normalized.abstract,
          normalized.doi,
          normalized.url,
          JSON.stringify(normalized.tags),
          now.toISOString(),
          metadataChanged ? 1 : 0,
          metadataChanged ? 1 : 0,
          metadataChanged ? 1 : 0,
          metadataChanged ? 1 : 0,
          metadataChanged ? 1 : 0,
          normalized.key,
        );
      return { paper: this.getZoteroPaperRequired(normalized.key), changed: true };
    }
    const timestamp = now.toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO zotero_items
         (item_key, version, item_type, title, creators_json, date_text, abstract, doi, url, tags_json,
          fulltext_state, analysis_state, analysis_json, analysis_attempts, analysis_error,
          last_fulltext_check_at, analyzed_at, card_version, first_seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 'pending', NULL, 0, NULL, NULL, NULL, -1, ?, ?)`,
      )
      .run(
        normalized.key,
        normalized.version,
        normalized.itemType,
        normalized.title,
        JSON.stringify(normalized.creators),
        normalized.date,
        normalized.abstract,
        normalized.doi,
        normalized.url,
        JSON.stringify(normalized.tags),
        timestamp,
        timestamp,
      );
    return { paper: this.getZoteroPaperRequired(normalized.key), changed: true };
  }

  getZoteroPaper(key: string): ZoteroPaper | undefined {
    const row = this.sqlite.prepare("SELECT * FROM zotero_items WHERE item_key = ?").get(key) as Row | undefined;
    return row ? parseZoteroPaper(row) : undefined;
  }

  listZoteroPapers(): ZoteroPaper[] {
    return (this.sqlite.prepare("SELECT * FROM zotero_items ORDER BY first_seen_at, item_key").all() as Row[]).map(
      parseZoteroPaper,
    );
  }

  listZoteroPapersByFirstSeen(from: Date, to: Date): ZoteroPaper[] {
    return (
      this.sqlite
        .prepare("SELECT * FROM zotero_items WHERE first_seen_at >= ? AND first_seen_at < ? ORDER BY first_seen_at, item_key")
        .all(from.toISOString(), to.toISOString()) as Row[]
    ).map(parseZoteroPaper);
  }

  listZoteroPapersTouchedBetween(from: Date, to: Date, limit = 5): ZoteroPaper[] {
    return (
      this.sqlite
        .prepare(
          `SELECT * FROM zotero_items
           WHERE (first_seen_at >= ? AND first_seen_at < ?)
              OR (updated_at >= ? AND updated_at < ?)
           ORDER BY updated_at DESC, first_seen_at DESC, item_key
           LIMIT ?`,
        )
        .all(
          from.toISOString(),
          to.toISOString(),
          from.toISOString(),
          to.toISOString(),
          Math.max(0, Math.trunc(limit)),
        ) as Row[]
    ).map(parseZoteroPaper);
  }

  listZoteroPapersForAnalysis(limit: number, now = new Date()): ZoteroPaper[] {
    const total = Math.max(0, Math.trunc(limit));
    if (!total) return [];
    // New papers always get the majority of the daily budget. A reserved retry
    // slot plus per-item backoff prevents a permanently failing paper from
    // blocking the queue, while still giving failed work another chance.
    const retryQuota = total >= 2 ? 1 : 0;
    const retries = this.pendingZoteroPapers(true, now, retryQuota);
    const fresh = this.pendingZoteroPapers(false, now, total - retries.length);
    const remaining = total - fresh.length - retries.length;
    if (remaining > 0) {
      retries.push(
        ...this.pendingZoteroPapers(true, now, retries.length + remaining).slice(retries.length),
      );
    }
    return [...fresh, ...retries];
  }

  private pendingZoteroPapers(retry: boolean, now: Date, limit: number): ZoteroPaper[] {
    if (limit <= 0) return [];
    const query = retry
      ? `SELECT * FROM zotero_items WHERE analysis_state = 'pending' AND analysis_attempts > 0
         AND (analysis_next_attempt_at IS NULL OR analysis_next_attempt_at <= ?)
         ORDER BY analysis_next_attempt_at, first_seen_at, item_key LIMIT ?`
      : `SELECT * FROM zotero_items WHERE analysis_state = 'pending' AND analysis_attempts = 0
         ORDER BY first_seen_at, item_key LIMIT ?`;
    const rows = retry
      ? (this.sqlite.prepare(query).all(now.toISOString(), limit) as Row[])
      : (this.sqlite.prepare(query).all(limit) as Row[]);
    return rows.map(parseZoteroPaper);
  }

  listZoteroPapersForFulltextCheck(checkedBefore: Date, limit: number): ZoteroPaper[] {
    return (
      this.sqlite
        .prepare(
          `SELECT * FROM zotero_items WHERE analysis_state = 'partial'
           AND (last_fulltext_check_at IS NULL OR last_fulltext_check_at < ?)
           ORDER BY last_fulltext_check_at, first_seen_at LIMIT ?`,
        )
        .all(checkedBefore.toISOString(), Math.max(0, Math.trunc(limit))) as Row[]
    ).map(parseZoteroPaper);
  }

  setZoteroFulltextState(key: string, state: ZoteroFulltextState, checkedAt = new Date()): void {
    this.sqlite
      .prepare("UPDATE zotero_items SET fulltext_state = ?, last_fulltext_check_at = ?, updated_at = ? WHERE item_key = ?")
      .run(state, checkedAt.toISOString(), checkedAt.toISOString(), key);
  }

  setZoteroCardVersion(key: string, version: number): void {
    this.sqlite
      .prepare("UPDATE zotero_items SET card_version = ? WHERE item_key = ?")
      .run(Math.trunc(version), key);
  }

  setZoteroAnalysisPending(key: string, now = new Date()): void {
    this.sqlite
      .prepare(
        `UPDATE zotero_items SET analysis_state = 'pending', analysis_error = NULL,
         analysis_next_attempt_at = NULL, updated_at = ? WHERE item_key = ?`,
      )
      .run(now.toISOString(), key);
  }

  saveZoteroAnalysis(key: string, analysis: PaperAnalysis, state: Exclude<ZoteroAnalysisState, "pending">, now = new Date()): void {
    this.sqlite
      .prepare(
        `UPDATE zotero_items SET analysis_json = ?, analysis_state = ?, analysis_attempts = analysis_attempts + 1,
         analysis_error = NULL, analysis_next_attempt_at = NULL, analyzed_at = ?, updated_at = ?
         WHERE item_key = ?`,
      )
      .run(JSON.stringify(analysis), state, now.toISOString(), now.toISOString(), key);
  }

  recordZoteroAnalysisFailure(key: string, error: string, now = new Date()): void {
    const retryAt = (minutes: number): string =>
      new Date(now.getTime() + minutes * 60_000).toISOString();
    this.sqlite
      .prepare(
        `UPDATE zotero_items SET analysis_attempts = analysis_attempts + 1, analysis_error = ?,
         analysis_next_attempt_at = CASE
           WHEN analysis_attempts = 0 THEN ?
           WHEN analysis_attempts = 1 THEN ?
           WHEN analysis_attempts = 2 THEN ?
           ELSE ? END,
         updated_at = ? WHERE item_key = ?`,
      )
      .run(
        error.slice(0, 1_000),
        retryAt(60),
        retryAt(6 * 60),
        retryAt(24 * 60),
        retryAt(72 * 60),
        now.toISOString(),
        key,
      );
  }

  getKnowledgeState(key: string): string | undefined {
    const row = this.sqlite.prepare("SELECT value FROM knowledge_sync_state WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : undefined;
  }

  setKnowledgeState(key: string, value: string): void {
    this.sqlite
      .prepare(
        `INSERT INTO knowledge_sync_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  stageWorkflowAction(kind: WorkflowActionKind, payload: Record<string, unknown>, now = new Date()): WorkflowAction {
    const payloadJson = JSON.stringify(payload);
    const existing = this.sqlite
      .prepare("SELECT * FROM workflow_actions WHERE kind = ? AND payload_json = ? AND status = 'pending' LIMIT 1")
      .get(kind, payloadJson) as Row | undefined;
    if (existing) return parseWorkflowAction(existing);
    const id = randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO workflow_actions
         (id, kind, payload_json, status, result_json, error, created_at, approved_at, executed_at)
         VALUES (?, ?, ?, 'pending', NULL, NULL, ?, NULL, NULL)`,
      )
      .run(id, kind, payloadJson, now.toISOString());
    return this.getWorkflowActionRequired(id);
  }

  approveWorkflowAction(id: string, now = new Date()): WorkflowAction {
    const action = this.getWorkflowActionRequired(id);
    if (action.status === "rejected") throw new Error("该操作已被拒绝。");
    if (action.status === "executing") throw new Error("该操作正在执行。");
    if (action.status === "executed" || action.status === "approved") return action;
    this.sqlite
      .prepare("UPDATE workflow_actions SET status = 'approved', approved_at = ?, error = NULL WHERE id = ?")
      .run(now.toISOString(), id);
    return this.getWorkflowActionRequired(id);
  }

  rejectWorkflowAction(id: string): WorkflowAction {
    const action = this.getWorkflowActionRequired(id);
    if (action.status === "executed") throw new Error("已执行的操作不能拒绝。");
    this.sqlite.prepare("UPDATE workflow_actions SET status = 'rejected' WHERE id = ?").run(id);
    return this.getWorkflowActionRequired(id);
  }

  listWorkflowActions(status?: WorkflowActionStatus): WorkflowAction[] {
    const rows = status
      ? this.sqlite.prepare("SELECT * FROM workflow_actions WHERE status = ? ORDER BY created_at").all(status)
      : this.sqlite.prepare("SELECT * FROM workflow_actions ORDER BY created_at").all();
    return (rows as Row[]).map(parseWorkflowAction);
  }

  claimWorkflowAction(id: string, kind: WorkflowActionKind, payload: Record<string, unknown>): WorkflowAction {
    const action = this.getWorkflowActionRequired(id);
    if (action.kind !== kind || JSON.stringify(action.payload) !== JSON.stringify(payload)) {
      throw new Error("审批内容与待执行操作不一致，请重新生成审批。");
    }
    if (action.status === "executed") return action;
    if (action.status !== "approved") throw new Error(`操作尚未获批，当前状态：${action.status}。`);
    const changed = this.sqlite
      .prepare("UPDATE workflow_actions SET status = 'executing' WHERE id = ? AND status = 'approved'")
      .run(id);
    if (changed.changes !== 1) throw new Error("操作已被其他执行器领取。");
    return this.getWorkflowActionRequired(id);
  }

  completeWorkflowAction(id: string, result: unknown, now = new Date()): WorkflowAction {
    this.sqlite
      .prepare(
        "UPDATE workflow_actions SET status = 'executed', result_json = ?, error = NULL, executed_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(result), now.toISOString(), id);
    return this.getWorkflowActionRequired(id);
  }

  getWorkflowAction(id: string): WorkflowAction | undefined {
    const row = this.sqlite.prepare("SELECT * FROM workflow_actions WHERE id = ?").get(id) as Row | undefined;
    return row ? parseWorkflowAction(row) : undefined;
  }

  failWorkflowAction(id: string, error: string): WorkflowAction {
    this.sqlite
      .prepare("UPDATE workflow_actions SET status = 'failed', error = ? WHERE id = ?")
      .run(error.slice(0, 1_000), id);
    return this.getWorkflowActionRequired(id);
  }

  getOperation(id: string): Operation | undefined {
    const row = this.sqlite.prepare("SELECT * FROM operations WHERE id = ?").get(id) as Row | undefined;
    return row ? parseOperation(row) : undefined;
  }

  findActiveOperation(kind?: OperationKind): Operation | undefined {
    const row = kind
      ? (this.sqlite
          .prepare(
            `SELECT * FROM operations WHERE status IN ('queued', 'running') AND kind = ?
             ORDER BY created_at LIMIT 1`,
          )
          .get(kind) as Row | undefined)
      : (this.sqlite
          .prepare(
            `SELECT * FROM operations WHERE status IN ('queued', 'running')
             ORDER BY created_at LIMIT 1`,
          )
          .get() as Row | undefined);
    return row ? parseOperation(row) : undefined;
  }

  createOperation(kind: OperationKind, now = new Date()): OperationStart {
    return this.transaction(() => {
      const row = this.sqlite
        .prepare(
          `SELECT * FROM operations WHERE status IN ('queued', 'running')
           ORDER BY created_at LIMIT 1`,
        )
        .get() as Row | undefined;
      if (row) {
        const active = parseOperation(row);
        const startedAt = Date.parse(active.startedAt ?? active.createdAt);
        const stale =
          Number.isFinite(startedAt) &&
          now.getTime() - startedAt > OPERATION_STALE_MINUTES * 60_000;
        if (!stale) {
          return { operation: active, created: false, busy: active.kind !== kind };
        }
        this.sqlite
          .prepare(
            `UPDATE operations SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`,
          )
          .run("操作超时未完成，已自动结束。", now.toISOString(), active.id);
      }
      const id = randomUUID();
      this.sqlite
        .prepare(
          `INSERT INTO operations
           (id, kind, status, stage, progress_current, progress_total, result_json, error,
            created_at, started_at, completed_at)
           VALUES (?, ?, 'queued', NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL)`,
        )
        .run(id, kind, now.toISOString());
      return { operation: this.getOperationRequired(id), created: true, busy: false };
    });
  }

  startOperation(id: string, stage: string, now = new Date()): Operation {
    this.sqlite
      .prepare(
        `UPDATE operations SET status = 'running', stage = ?,
         started_at = COALESCE(started_at, ?), error = NULL WHERE id = ?`,
      )
      .run(stage, now.toISOString(), id);
    return this.getOperationRequired(id);
  }

  updateOperationStage(id: string, stage: string): Operation {
    this.sqlite.prepare("UPDATE operations SET stage = ? WHERE id = ?").run(stage, id);
    return this.getOperationRequired(id);
  }

  setOperationProgress(id: string, current: number, total: number | null): Operation {
    this.sqlite
      .prepare("UPDATE operations SET progress_current = ?, progress_total = ? WHERE id = ?")
      .run(
        Math.max(0, Math.trunc(current)),
        total === null ? null : Math.max(0, Math.trunc(total)),
        id,
      );
    return this.getOperationRequired(id);
  }

  succeedOperation(id: string, result: unknown, now = new Date()): Operation {
    this.sqlite
      .prepare(
        `UPDATE operations SET status = 'succeeded', result_json = ?, error = NULL,
         stage = NULL, completed_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(result ?? null), now.toISOString(), id);
    return this.getOperationRequired(id);
  }

  failOperation(id: string, error: string, now = new Date()): Operation {
    this.sqlite
      .prepare(
        `UPDATE operations SET status = 'failed', error = ?, stage = NULL, completed_at = ?
         WHERE id = ?`,
      )
      .run(error.slice(0, 1_000), now.toISOString(), id);
    return this.getOperationRequired(id);
  }

  ensureDailyBriefing(config: AppConfig, now = new Date()): void {
    const schedule: JobSchedule = { kind: "daily", time: config.briefingTime };
    const enabled = briefingEnabled(config);
    const next = enabled ? nextOccurrence(schedule, now, config.timezone) : null;
    this.sqlite
      .prepare(
        `INSERT INTO jobs
         (id, kind, source_id, title, body, schedule_json, timezone, next_run_at,
          enabled, catchup_minutes, created_at, updated_at)
         VALUES ('daily-briefing', 'briefing', NULL, '每日简报', '', ?, ?, ?, ?, 120, ?, ?)
         ON CONFLICT(id) DO UPDATE SET schedule_json = excluded.schedule_json,
          timezone = excluded.timezone, enabled = excluded.enabled, updated_at = excluded.updated_at,
          next_run_at = CASE
            WHEN excluded.enabled = 0 THEN NULL
            WHEN jobs.schedule_json <> excluded.schedule_json
              OR jobs.timezone <> excluded.timezone
              OR jobs.enabled = 0
            THEN excluded.next_run_at ELSE jobs.next_run_at END`,
      )
      .run(
        JSON.stringify(schedule),
        config.timezone,
        next?.toISOString() ?? null,
        enabled ? 1 : 0,
        now.toISOString(),
        now.toISOString(),
      );
  }

  ensureKnowledgeDigest(config: AppConfig, now = new Date()): void {
    const schedule: JobSchedule = { kind: "daily", time: config.knowledgeDigestTime };
    const enabled = knowledgeDigestEnabled(config);
    const next = enabled ? nextOccurrence(schedule, now, config.timezone) : null;
    this.sqlite
      .prepare(
        `INSERT INTO jobs
         (id, kind, source_id, title, body, schedule_json, timezone, next_run_at,
          enabled, catchup_minutes, created_at, updated_at)
         VALUES (?, 'briefing', NULL, '晚间知识整理', '', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET schedule_json = excluded.schedule_json,
          timezone = excluded.timezone, title = excluded.title, body = excluded.body,
          catchup_minutes = excluded.catchup_minutes, enabled = excluded.enabled,
          updated_at = excluded.updated_at,
          next_run_at = CASE
            WHEN excluded.enabled = 0 THEN NULL
            WHEN jobs.schedule_json <> excluded.schedule_json
              OR jobs.timezone <> excluded.timezone
              OR jobs.enabled = 0
            THEN excluded.next_run_at ELSE jobs.next_run_at END`,
      )
      .run(
        KNOWLEDGE_DIGEST_JOB_ID,
        JSON.stringify(schedule),
        config.timezone,
        next?.toISOString() ?? null,
        enabled ? 1 : 0,
        KNOWLEDGE_DIGEST_CATCHUP_MINUTES,
        now.toISOString(),
        now.toISOString(),
      );
  }

  scheduleMissedKnowledgeDigest(config: AppConfig, now = new Date()): boolean {
    if (!knowledgeDigestEnabled(config)) return false;
    const job = this.sqlite
      .prepare("SELECT created_at FROM jobs WHERE id = ?")
      .get(KNOWLEDGE_DIGEST_JOB_ID) as Row | undefined;
    if (!job) return false;
    const createdAt = Date.parse(String(job.created_at));
    const lookbackStart = Math.max(
      Number.isFinite(createdAt) ? createdAt : 0,
      now.getTime() - KNOWLEDGE_DIGEST_LOOKBACK_DAYS * 24 * 60 * 60_000,
    );
    const schedule: JobSchedule = { kind: "daily", time: config.knowledgeDigestTime };
    const today = localDayRange(now, config.timezone);
    const missed: Date[] = [];
    for (let offset = 0; offset <= KNOWLEDGE_DIGEST_LOOKBACK_DAYS; offset += 1) {
      const anchor = new Date(today.start.getTime() - offset * 24 * 60 * 60_000);
      const range = localDayRange(anchor, config.timezone);
      const occurrence = nextOccurrence(schedule, new Date(range.start.getTime() - 1), config.timezone);
      if (!occurrence) continue;
      if (occurrence.getTime() > now.getTime() || occurrence.getTime() < lookbackStart) continue;
      const run = this.sqlite
        .prepare(
          `SELECT status, attempts, completed_at FROM job_runs
           WHERE job_id = ? AND scheduled_for = ?`,
        )
        .get(KNOWLEDGE_DIGEST_JOB_ID, occurrence.toISOString()) as Row | undefined;
      let handled = false;
      if (run) {
        const status = String(run.status);
        if (status === "delivered" || status === "skipped") {
          handled = true;
        } else if (status === "failed") {
          const delay = failedJobRetryDelayMinutes(Number(run.attempts));
          const completedAt = run.completed_at ? Date.parse(String(run.completed_at)) : 0;
          handled = delay === null || now.getTime() - completedAt < delay * 60_000;
        }
      }
      if (!handled) missed.push(occurrence);
    }
    if (!missed.length) return false;
    missed.sort((left, right) => left.getTime() - right.getTime());
    const earliest = missed[0]!;
    this.sqlite
      .prepare("UPDATE jobs SET enabled = 1, next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(earliest.toISOString(), now.toISOString(), KNOWLEDGE_DIGEST_JOB_ID);
    return true;
  }

  scheduleMissedDailyBriefing(config: AppConfig, now = new Date()): boolean {
    if (!briefingEnabled(config)) return false;
    const range = localDayRange(now, config.timezone);
    const schedule: JobSchedule = { kind: "daily", time: config.briefingTime };
    const scheduled = nextOccurrence(schedule, new Date(range.start.getTime() - 1), config.timezone);
    if (!scheduled || now.getTime() <= scheduled.getTime()) return false;
    const delivered = this.sqlite
      .prepare(
        `SELECT 1 FROM job_runs WHERE job_id = 'daily-briefing' AND status = 'delivered'
         AND completed_at >= ? AND completed_at < ? LIMIT 1`,
      )
      .get(range.start.toISOString(), range.end.toISOString());
    if (delivered) return false;
    this.sqlite
      .prepare("UPDATE jobs SET enabled = 1, next_run_at = ?, updated_at = ? WHERE id = 'daily-briefing'")
      .run(now.toISOString(), now.toISOString());
    return true;
  }

  listDueJobs(now = new Date(), limit = 25): ScheduledJob[] {
    return (
      this.sqlite
        .prepare(
          `SELECT * FROM jobs WHERE enabled = 1 AND next_run_at IS NOT NULL
           AND next_run_at <= ? ORDER BY next_run_at LIMIT ?`,
        )
        .all(now.toISOString(), limit) as Row[]
    ).map(parseJob);
  }

  beginRun(job: ScheduledJob, scheduledFor: string, now = new Date()): string | undefined {
    const existing = this.sqlite
      .prepare("SELECT * FROM job_runs WHERE job_id = ? AND scheduled_for = ?")
      .get(job.id, scheduledFor) as Row | undefined;
    if (existing) {
      const status = String(existing.status);
      if (status === "failed") {
        // The catch-up scheduler deliberately points next_run_at at a failed
        // occurrence after its retry delay. Re-open that run and execute it.
        this.sqlite
          .prepare(
            `UPDATE job_runs SET status = 'claimed', attempts = attempts + 1,
             started_at = ?, error = NULL, completed_at = NULL WHERE id = ?`,
          )
          .run(now.toISOString(), existing.id as string);
        return String(existing.id);
      }
      if (status !== "claimed") {
        // Recover a crash that happened after recording the outcome but before advancing the schedule.
        this.advanceJob(job, scheduledFor, now);
        return undefined;
      }
      const stale =
        now.getTime() - Date.parse(String(existing.started_at)) >= 10 * 60_000;
      if (!stale) return undefined;
      this.sqlite
        .prepare("UPDATE job_runs SET attempts = attempts + 1, started_at = ?, error = NULL WHERE id = ?")
        .run(now.toISOString(), existing.id as string);
      return String(existing.id);
    }
    const id = randomUUID();
    try {
      this.sqlite
        .prepare(
          `INSERT INTO job_runs (id, job_id, scheduled_for, status, attempts, started_at)
           VALUES (?, ?, ?, 'claimed', 1, ?)`,
        )
        .run(id, job.id, scheduledFor, now.toISOString());
    } catch (error) {
      if (String((error as { code?: string }).code).startsWith("SQLITE_CONSTRAINT")) return undefined;
      throw error;
    }
    return id;
  }

  completeRun(
    runId: string,
    status: "delivered" | "failed" | "skipped",
    error: string | null,
    now = new Date(),
  ): void {
    this.sqlite
      .prepare("UPDATE job_runs SET status = ?, error = ?, completed_at = ? WHERE id = ?")
      .run(status, error, now.toISOString(), runId);
  }

  advanceJob(job: ScheduledJob, scheduledFor: string, now = new Date()): void {
    const next =
      job.schedule.kind === "once"
        ? null
        : nextOccurrence(job.schedule, new Date(Date.parse(scheduledFor) + 1000), job.timezone);
    this.sqlite
      .prepare("UPDATE jobs SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(next ? 1 : 0, next?.toISOString() ?? null, now.toISOString(), job.id);
  }

  runCount(jobId: string): number {
    const row = this.sqlite.prepare("SELECT COUNT(*) AS count FROM job_runs WHERE job_id = ?").get(jobId) as Row;
    return Number(row.count);
  }

  getJob(id: string): ScheduledJob | undefined {
    const row = this.sqlite.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? parseJob(row) : undefined;
  }

  getLatestJobRun(jobId: string): JobRun | undefined {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM job_runs WHERE job_id = ?
         ORDER BY scheduled_for DESC, started_at DESC LIMIT 1`,
      )
      .get(jobId) as Row | undefined;
    return row ? parseJobRun(row) : undefined;
  }

  private getLectureRequired(id: string): Lecture {
    const lecture = this.getLecture(id);
    if (!lecture) throw new Error(`找不到讲座：${id}`);
    return lecture;
  }

  private getResearchTaskRequired(id: string): ResearchTask {
    const task = this.getResearchTask(id);
    if (!task) throw new Error(`找不到科研任务：${id}`);
    return task;
  }

  private getWorkflowActionRequired(id: string): WorkflowAction {
    const row = this.sqlite.prepare("SELECT * FROM workflow_actions WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error(`找不到待审批操作：${id}`);
    return parseWorkflowAction(row);
  }

  private getOperationRequired(id: string): Operation {
    const operation = this.getOperation(id);
    if (!operation) throw new Error(`找不到操作：${id}`);
    return operation;
  }

  private getJobRequired(id: string): ScheduledJob {
    const row = this.sqlite.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error(`找不到提醒：${id}`);
    return parseJob(row);
  }

  private getZoteroPaperRequired(key: string): ZoteroPaper {
    const paper = this.getZoteroPaper(key);
    if (!paper) throw new Error(`找不到 Zotero 条目：${key}`);
    return paper;
  }

  private createLectureJobs(
    lectureId: string,
    title: string,
    startAt: string,
    requiresPresentation: boolean,
    now: Date,
  ): void {
    const start = parseInstant(startAt);
    const offsets = requiresPresentation ? [72 * 60, 24 * 60] : [24 * 60];
    for (const offsetMinutes of offsets) {
      const trigger = new Date(start.getTime() - offsetMinutes * 60_000);
      if (trigger.getTime() <= now.getTime()) continue;
      const schedule: JobSchedule = { kind: "once", at: trigger.toISOString() };
      this.insertJob({
        id: randomUUID(),
        kind: "lecture",
        sourceId: lectureId,
        title: `讲座提醒：${title}`,
        body: `讲座将在 ${offsetMinutes / 60} 小时后开始。`,
        schedule,
        timezone: "UTC",
        nextRunAt: trigger,
        catchupMinutes: 0,
        now,
      });
    }
  }

  private disableLectureJobs(lectureId: string, now: Date): void {
    this.sqlite
      .prepare("UPDATE jobs SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE kind = 'lecture' AND source_id = ?")
      .run(now.toISOString(), lectureId);
  }

  private insertJob(input: {
    id: string;
    kind: ScheduledJob["kind"];
    sourceId: string | null;
    title: string;
    body: string;
    schedule: JobSchedule;
    timezone: string;
    nextRunAt: Date;
    catchupMinutes: number;
    now: Date;
  }): void {
    this.sqlite
      .prepare(
        `INSERT INTO jobs
         (id, kind, source_id, title, body, schedule_json, timezone, next_run_at,
          enabled, catchup_minutes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.kind,
        input.sourceId,
        input.title,
        input.body,
        JSON.stringify(input.schedule),
        input.timezone,
        input.nextRunAt.toISOString(),
        input.catchupMinutes,
        input.now.toISOString(),
        input.now.toISOString(),
      );
  }

  private transaction<T>(operation: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS lectures (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT,
        location TEXT,
        speaker TEXT,
        notes TEXT,
        requires_presentation INTEGER NOT NULL DEFAULT 0 CHECK (requires_presentation IN (0, 1)),
        status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('reminder', 'lecture', 'briefing')),
        source_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        timezone TEXT NOT NULL,
        next_run_at TEXT,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        catchup_minutes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs(enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS job_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        scheduled_for TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('claimed', 'delivered', 'failed', 'skipped')),
        attempts INTEGER NOT NULL,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(job_id, scheduled_for)
      );
      CREATE TABLE IF NOT EXISTS research_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        task_kind TEXT NOT NULL DEFAULT 'research' CHECK (task_kind IN ('research', 'assignment', 'other')),
        source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'email')),
        source_id TEXT,
        deadline TEXT,
        estimated_minutes INTEGER NOT NULL CHECK (estimated_minutes BETWEEN 5 AND 1440),
        priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
        status TEXT NOT NULL CHECK (status IN ('draft', 'planned', 'in_progress', 'needs_replan', 'completed', 'cancelled')),
        confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
        planned_start TEXT,
        planned_end TEXT,
        calendar_event_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS research_tasks_status_idx ON research_tasks(status, deadline);
      CREATE TABLE IF NOT EXISTS workflow_actions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('calendar.create', 'calendar.update')),
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'executing', 'executed', 'failed', 'rejected')),
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        executed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS workflow_actions_status_idx ON workflow_actions(status, created_at);
      CREATE TABLE IF NOT EXISTS zotero_items (
        item_key TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        item_type TEXT NOT NULL,
        title TEXT NOT NULL,
        creators_json TEXT NOT NULL,
        date_text TEXT,
        abstract TEXT,
        doi TEXT,
        url TEXT,
        tags_json TEXT NOT NULL,
        fulltext_state TEXT NOT NULL CHECK (fulltext_state IN ('unknown', 'available', 'unavailable')),
        analysis_state TEXT NOT NULL CHECK (analysis_state IN ('pending', 'partial', 'complete')),
        analysis_json TEXT,
        analysis_attempts INTEGER NOT NULL DEFAULT 0,
        analysis_error TEXT,
        analysis_next_attempt_at TEXT,
        last_fulltext_check_at TEXT,
        analyzed_at TEXT,
        card_version INTEGER NOT NULL DEFAULT -1,
        first_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS zotero_items_analysis_idx ON zotero_items(analysis_state, first_seen_at);
      CREATE INDEX IF NOT EXISTS zotero_items_first_seen_idx ON zotero_items(first_seen_at);
      CREATE TABLE IF NOT EXISTS knowledge_sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('knowledge.sync', 'knowledge.digest')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
        stage TEXT,
        progress_current INTEGER,
        progress_total INTEGER,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS operations_status_idx ON operations(status, created_at);
    `);
    const lectureColumns = this.sqlite.prepare("PRAGMA table_info(lectures)").all() as Row[];
    if (!lectureColumns.some((column) => String(column.name) === "requires_presentation")) {
      this.sqlite.exec(
        "ALTER TABLE lectures ADD COLUMN requires_presentation INTEGER NOT NULL DEFAULT 0 CHECK (requires_presentation IN (0, 1))",
      );
    }
    const taskColumns = this.sqlite.prepare("PRAGMA table_info(research_tasks)").all() as Row[];
    if (!taskColumns.some((column) => String(column.name) === "task_kind")) {
      this.sqlite.exec(
        "ALTER TABLE research_tasks ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'research' CHECK (task_kind IN ('research', 'assignment', 'other'))",
      );
    }
    const zoteroColumns = this.sqlite.prepare("PRAGMA table_info(zotero_items)").all() as Row[];
    if (!zoteroColumns.some((column) => String(column.name) === "card_version")) {
      this.sqlite.exec("ALTER TABLE zotero_items ADD COLUMN card_version INTEGER NOT NULL DEFAULT -1");
    }
    if (!zoteroColumns.some((column) => String(column.name) === "analysis_next_attempt_at")) {
      this.sqlite.exec("ALTER TABLE zotero_items ADD COLUMN analysis_next_attempt_at TEXT");
    }
    this.sqlite
      .prepare(
        `UPDATE jobs SET enabled = 0, next_run_at = NULL, updated_at = ?
         WHERE kind = 'lecture' AND enabled = 1 AND body = '讲座将在 2 小时后开始。'`,
      )
      .run(new Date().toISOString());
  }
}

function failedJobRetryDelayMinutes(attempts: number): number | null {
  if (attempts <= 1) return 60;
  if (attempts === 2) return 6 * 60;
  if (attempts === 3) return 24 * 60;
  return null;
}

function normalizeLectureInput(input: LectureInput): LectureInput {
  const title = requiredText(input.title, "讲座标题", 200);
  const start = parseInstant(input.startAt);
  const end = input.endAt ? parseInstant(input.endAt) : undefined;
  if (end && end.getTime() <= start.getTime()) throw new Error("讲座结束时间必须晚于开始时间。");
  return {
    title,
    startAt: start.toISOString(),
    ...(end ? { endAt: end.toISOString() } : {}),
    ...(optionalText(input.location, 500) ? { location: optionalText(input.location, 500)! } : {}),
    ...(optionalText(input.speaker, 200) ? { speaker: optionalText(input.speaker, 200)! } : {}),
    ...(optionalText(input.notes, 4_000) ? { notes: optionalText(input.notes, 4_000)! } : {}),
    requiresPresentation: input.requiresPresentation ?? false,
  };
}

function parseLecture(row: Row): Lecture {
  return {
    id: String(row.id),
    title: String(row.title),
    startAt: String(row.start_at),
    endAt: nullableString(row.end_at),
    location: nullableString(row.location),
    speaker: nullableString(row.speaker),
    notes: nullableString(row.notes),
    requiresPresentation: Number(row.requires_presentation) === 1,
    status: String(row.status) as Lecture["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseJob(row: Row): ScheduledJob {
  const schedule = JSON.parse(String(row.schedule_json)) as JobSchedule;
  validateSchedule(schedule);
  return {
    id: String(row.id),
    kind: String(row.kind) as ScheduledJob["kind"],
    sourceId: nullableString(row.source_id),
    title: String(row.title),
    body: String(row.body),
    schedule,
    timezone: String(row.timezone),
    nextRunAt: nullableString(row.next_run_at),
    enabled: Number(row.enabled) === 1,
    catchupMinutes: Number(row.catchup_minutes),
  };
}

function parseJobRun(row: Row): JobRun {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    scheduledFor: String(row.scheduled_for),
    status: String(row.status) as JobRunStatus,
    attempts: Number(row.attempts),
    error: nullableString(row.error),
    startedAt: String(row.started_at),
    completedAt: nullableString(row.completed_at),
  };
}

function normalizeResearchTaskInput(input: ResearchTaskInput): Required<
  Pick<ResearchTaskInput, "title" | "taskKind" | "sourceType" | "estimatedMinutes" | "priority" | "confidence">
> &
  Pick<ResearchTaskInput, "sourceId" | "deadline"> {
  const estimatedMinutes = input.estimatedMinutes ?? 60;
  if (!Number.isInteger(estimatedMinutes) || estimatedMinutes < 5 || estimatedMinutes > 1440) {
    throw new Error("预计耗时必须是 5 到 1440 分钟的整数。");
  }
  const priority = input.priority ?? "medium";
  if (!(["low", "medium", "high"] as const).includes(priority)) throw new Error("任务优先级无效。");
  const taskKind = input.taskKind ?? "research";
  if (!(["research", "assignment", "other"] as const).includes(taskKind)) throw new Error("任务分类无效。");
  const sourceType = input.sourceType ?? "manual";
  if (!(["manual", "email"] as const).includes(sourceType)) throw new Error("任务来源无效。");
  const sourceId = optionalText(input.sourceId, 1_000);
  if (sourceType === "email" && !sourceId) throw new Error("邮件来源任务必须保留 Gmail message ID。");
  const confidence = input.confidence ?? 1;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("置信度必须在 0 到 1 之间。");
  return {
    title: requiredText(input.title, "任务标题", 200),
    taskKind,
    sourceType,
    ...(sourceId ? { sourceId } : {}),
    ...(input.deadline ? { deadline: parseInstant(input.deadline).toISOString() } : {}),
    estimatedMinutes,
    priority,
    confidence,
  };
}

function parseResearchTask(row: Row): ResearchTask {
  return {
    id: String(row.id),
    title: String(row.title),
    taskKind: (String(row.task_kind ?? "research")) as TaskKind,
    sourceType: String(row.source_type) as ResearchTask["sourceType"],
    sourceId: nullableString(row.source_id),
    deadline: nullableString(row.deadline),
    estimatedMinutes: Number(row.estimated_minutes),
    priority: String(row.priority) as ResearchTask["priority"],
    status: String(row.status) as ResearchTaskStatus,
    confidence: Number(row.confidence),
    plannedStart: nullableString(row.planned_start),
    plannedEnd: nullableString(row.planned_end),
    calendarEventId: nullableString(row.calendar_event_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseWorkflowAction(row: Row): WorkflowAction {
  return {
    id: String(row.id),
    kind: String(row.kind) as WorkflowActionKind,
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    status: String(row.status) as WorkflowActionStatus,
    result: row.result_json ? JSON.parse(String(row.result_json)) : null,
    error: nullableString(row.error),
    createdAt: String(row.created_at),
    approvedAt: nullableString(row.approved_at),
    executedAt: nullableString(row.executed_at),
  };
}

function parseOperation(row: Row): Operation {
  return {
    id: String(row.id),
    kind: String(row.kind) as OperationKind,
    status: String(row.status) as OperationStatus,
    stage: nullableString(row.stage),
    progressCurrent: row.progress_current === null ? null : Number(row.progress_current),
    progressTotal: row.progress_total === null ? null : Number(row.progress_total),
    result: row.result_json ? JSON.parse(String(row.result_json)) : null,
    error: nullableString(row.error),
    createdAt: String(row.created_at),
    startedAt: nullableString(row.started_at),
    completedAt: nullableString(row.completed_at),
  };
}

function normalizeZoteroPaperMetadata(input: ZoteroPaperMetadata): ZoteroPaperMetadata {
  return {
    key: requiredText(input.key, "Zotero 条目 key", 200),
    version: Number.isFinite(input.version) ? Math.max(0, Math.trunc(input.version)) : 0,
    itemType: requiredText(input.itemType, "Zotero 条目类型", 100),
    title: requiredText(input.title, "论文标题", 1_000),
    creators: input.creators
      .map((creator) => ({
        creatorType: String(creator.creatorType ?? "").slice(0, 100),
        firstName: String(creator.firstName ?? "").slice(0, 200),
        lastName: String(creator.lastName ?? "").slice(0, 200),
        name: String(creator.name ?? "").slice(0, 400),
      }))
      .slice(0, 100),
    date: optionalText(input.date ?? undefined, 200) ?? null,
    abstract: optionalText(input.abstract ?? undefined, 100_000) ?? null,
    doi: optionalText(input.doi ?? undefined, 500) ?? null,
    url: optionalText(input.url ?? undefined, 2_000) ?? null,
    tags: input.tags.map((tag) => tag.trim()).filter(Boolean).slice(0, 100),
  };
}

function parseZoteroPaper(row: Row): ZoteroPaper {
  const analysisJson = nullableString(row.analysis_json);
  return {
    key: String(row.item_key),
    version: Number(row.version),
    itemType: String(row.item_type),
    title: String(row.title),
    creators: JSON.parse(String(row.creators_json)) as ZoteroCreator[],
    date: nullableString(row.date_text),
    abstract: nullableString(row.abstract),
    doi: nullableString(row.doi),
    url: nullableString(row.url),
    tags: JSON.parse(String(row.tags_json)) as string[],
    fulltextState: String(row.fulltext_state) as ZoteroFulltextState,
    analysisState: String(row.analysis_state) as ZoteroAnalysisState,
    analysis: analysisJson ? (JSON.parse(analysisJson) as PaperAnalysis) : null,
    analysisAttempts: Number(row.analysis_attempts),
    analysisError: nullableString(row.analysis_error),
    analysisNextAttemptAt: nullableString(row.analysis_next_attempt_at),
    lastFulltextCheckAt: nullableString(row.last_fulltext_check_at),
    analyzedAt: nullableString(row.analyzed_at),
    cardVersion: Number(row.card_version ?? -1),
    firstSeenAt: String(row.first_seen_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizeOptionalInstant(value: string | null): string | null {
  return value === null ? null : parseInstant(value).toISOString();
}

function requiredText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空。`);
  if (normalized.length > maximum) throw new Error(`${label}不能超过 ${maximum} 个字符。`);
  return normalized;
}

function optionalText(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maximum) throw new Error(`文本不能超过 ${maximum} 个字符。`);
  return normalized;
}

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function assertTimezone(value: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
  } catch {
    throw new Error(`无效时区：${value}`);
  }
}
