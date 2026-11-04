import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ApprovalExecutor } from "../src/calendar-actions.js";
import type { AppConfig } from "../src/config.js";
import { AppDatabase } from "../src/database.js";
import { ConversationArchivedError, ConversationNotFoundError, conversationTitleFrom } from "../src/agent/session.js";
import type { CalendarEvent } from "../src/integrations/google.js";
import type { AppPaths } from "../src/paths.js";
import {
  startLocalServer,
  type LocalServerOptions,
} from "../src/server/local-server.js";
import type { CalendarSource } from "../src/server/sources.js";
import type {
  Approval,
  CalendarResponse,
  ConversationDto,
  ConversationTranscriptResponse,
  OperationDto,
  PaperSummary,
  Settings,
  TranscriptMessageDto,
  WorkflowRunDto,
  WorkflowStepDto,
} from "../src/server/types.js";

const NOW = new Date("2026-10-30T02:00:00.000Z"); // 10:00 in Shanghai
const TOKEN = "api-test-token";

test("task lifecycle enforces the documented state machine", async () => {
  await withApi(async (api) => {
    const created = await api.send("/api/tasks", "POST", {
      title: "生命周期任务",
      taskKind: "research",
      estimatedMinutes: 45,
      priority: "high",
      deadline: "2026-10-31T10:00:00+08:00",
    });
    assert.equal(created.status, 201);
    const task = (await created.json()) as { task: { id: string; status: string } };
    assert.equal(task.task.status, "draft");

    const started = await api.send(`/api/tasks/${task.task.id}`, "PATCH", { operation: "start" });
    assert.equal(started.status, 200);
    assert.equal(((await started.json()) as { task: { status: string } }).task.status, "in_progress");

    const completed = await api.send(`/api/tasks/${task.task.id}`, "PATCH", { operation: "complete" });
    assert.equal(completed.status, 200);
    assert.equal(((await completed.json()) as { task: { status: string } }).task.status, "completed");

    const repeated = await api.send(`/api/tasks/${task.task.id}`, "PATCH", { operation: "complete" });
    assert.equal(repeated.status, 409);

    const invalid = await api.send("/api/tasks", "POST", { title: "缺少耗时" });
    assert.equal(invalid.status, 422);

    const edited = await api.fixture.database.createResearchTask({
      title: "可编辑任务",
      estimatedMinutes: 30,
    }, NOW);
    const edit = await api.send(`/api/tasks/${edited.id}`, "PATCH", {
      operation: "edit",
      title: "已编辑任务",
      priority: "low",
      deadline: null,
    });
    assert.equal(edit.status, 200);
    const editedBody = (await edit.json()) as {
      task: { title: string; priority: string; deadline: string | null };
    };
    assert.equal(editedBody.task.title, "已编辑任务");
    assert.equal(editedBody.task.priority, "low");
    assert.equal(editedBody.task.deadline, null);
  });
});

test("candidate slots use calendar and schedule creates only a pending approval", async () => {
  await withApi(async (api) => {
    const taskId = api.fixture.draftTaskId;
    const slotsResponse = await api.get(
      `/api/tasks/${taskId}/candidate-slots?start=2026-10-30T00:00:00Z&end=2026-10-31T00:00:00Z&limit=5`,
    );
    assert.equal(slotsResponse.status, 200);
    const slots = (await slotsResponse.json()) as {
      slots: Array<{ startAt: string; endAt: string; availableMinutes: number }>;
    };
    assert.equal(slots.slots[0]?.startAt, "2026-10-30T01:00:00.000Z");
    assert.equal(slots.slots[0]?.endAt, "2026-10-30T02:00:00.000Z");
    assert.equal(slots.slots[0]?.availableMinutes, 60);

    const staged = await api.send(`/api/tasks/${taskId}/schedule`, "POST", {
      startAt: "2026-10-30T01:00:00Z",
      endAt: "2026-10-30T02:00:00Z",
    });
    assert.equal(staged.status, 201);
    const stagedBody = (await staged.json()) as { approval: Approval };
    assert.equal(stagedBody.approval.status, "pending");
    assert.equal(stagedBody.approval.display.proposedStart, "2026-10-30T01:00:00.000Z");

    const taskAfterStage = api.fixture.database.getResearchTask(taskId);
    assert.equal(taskAfterStage?.status, "draft");
    assert.equal(taskAfterStage?.calendarEventId, null);

    const approved = await api.send(
      `/api/approvals/${stagedBody.approval.id}/approve`,
      "POST",
    );
    assert.equal(approved.status, 200);
    const approvedBody = (await approved.json()) as { approval: Approval };
    assert.equal(approvedBody.approval.status, "executed");
    assert.equal(api.fixture.createdEvents.length, 1);

    const planned = api.fixture.database.getResearchTask(taskId);
    assert.equal(planned?.status, "planned");
    assert.equal(planned?.calendarEventId, "created-event-1");
    assert.equal(planned?.plannedStart, "2026-10-30T01:00:00.000Z");
  });
});

test("calendar aggregates all sources and deduplicates planned tasks", async () => {
  await withApi(async (api) => {
    const response = await api.get(
      "/api/calendar?start=2026-10-30T00:00:00Z&end=2026-10-31T00:00:00Z",
    );
    assert.equal(response.status, 200);
    const calendar = (await response.json()) as CalendarResponse;
    assert.equal(calendar.status, "success");
    assert.ok(calendar.items.some((item) => item.source === "google" && item.linkedObjectId === api.fixture.plannedTaskId));
    assert.ok(calendar.items.some((item) => item.source === "lecture"));
    assert.ok(calendar.items.some((item) => item.source === "approval"));
    assert.equal(
      calendar.items.some((item) => item.id === `task:${api.fixture.plannedTaskId}`),
      false,
    );
  });
});

test("calendar degrades to partial while keeping local items", async () => {
  await withApi(
    async (api) => {
      const response = await api.get(
        "/api/calendar?start=2026-10-30T00:00:00Z&end=2026-10-31T00:00:00Z",
      );
      const calendar = (await response.json()) as CalendarResponse;
      assert.equal(calendar.status, "partial");
      assert.equal(calendar.sources.calendar?.state, "unavailable");
      assert.ok(calendar.items.some((item) => item.source === "lecture"));
      assert.ok(calendar.items.some((item) => item.source === "approval"));
    },
    {
      calendar: {
        async list() {
          throw new Error("calendar offline");
        },
      },
    },
  );
});

test("papers expose real evidence states, counts, and detail links", async () => {
  await withApi(async (api) => {
    const response = await api.get("/api/papers?limit=10");
    assert.equal(response.status, 200);
    const list = (await response.json()) as {
      items: PaperSummary[];
      counts: Record<string, number>;
      total: number;
    };
    assert.deepEqual(list.counts, { pending: 1, retrying: 1, partial: 1, complete: 1 });
    assert.equal(list.total, 4);

    const complete = await api.get("/api/papers?state=complete");
    const completeBody = (await complete.json()) as { items: PaperSummary[] };
    assert.equal(completeBody.items.length, 1);
    assert.equal(completeBody.items[0]?.evidenceState, "truncated_fulltext");

    const detail = await api.get("/api/papers/PAPER-COMPLETE");
    assert.equal(detail.status, 200);
    const detailBody = (await detail.json()) as {
      paper: {
        analysis: { truncated: boolean; direction: string } | null;
        links: { zotero: string; obsidian: string | null };
      };
    };
    assert.equal(detailBody.paper.analysis?.truncated, true);
    assert.match(detailBody.paper.links.zotero, /^zotero:\/\/select\/library\/items\//);

    const missing = await api.get("/api/papers/NOPE");
    assert.equal(missing.status, 404);
  });
});

test("knowledge operations are persisted and mutually exclusive", async () => {
  await withApi(async (api) => {
    const sync = await api.send("/api/knowledge/sync", "POST");
    assert.equal(sync.status, 202);
    const syncBody = (await sync.json()) as { operation: OperationDto };
    assert.equal(syncBody.operation.kind, "knowledge.sync");

    const digest = await api.send("/api/knowledge/digest", "POST");
    assert.equal(digest.status, 409);

    const finished = await api.waitOperation(syncBody.operation.id);
    assert.equal(finished.status, "succeeded");
    assert.deepEqual(finished.result, { added: 1 });

    const digestAgain = await api.send("/api/knowledge/digest", "POST");
    assert.equal(digestAgain.status, 202);
    const digestBody = (await digestAgain.json()) as { operation: OperationDto };
    const digestFinished = await api.waitOperation(digestBody.operation.id);
    assert.equal(digestFinished.status, "succeeded");
    assert.deepEqual(digestFinished.result, { digest: true });

    const missing = await api.get("/api/operations/00000000-0000-4000-8000-000000000000");
    assert.equal(missing.status, 404);
  });
});

test("lectures can be created and listed with domain validation", async () => {
  await withApi(async (api) => {
    const created = await api.send("/api/lectures", "POST", {
      title: "新讲座",
      startAt: "2026-11-01T19:00:00+08:00",
      endAt: "2026-11-01T20:30:00+08:00",
      location: "报告厅",
      speaker: "王老师",
      requiresPresentation: true,
    });
    assert.equal(created.status, 201);
    const lecture = ((await created.json()) as { lecture: { id: string; title: string } }).lecture;
    assert.equal(lecture.title, "新讲座");

    const list = await api.get(
      "/api/lectures?start=2026-11-01T00:00:00Z&end=2026-11-02T00:00:00Z",
    );
    assert.equal(list.status, 200);
    const items = ((await list.json()) as { items: Array<{ id: string }> }).items;
    assert.ok(items.some((item) => item.id === lecture.id));

    const invalid = await api.send("/api/lectures", "POST", {
      title: "无时区",
      startAt: "2026-11-01T19:00:00",
    });
    assert.equal(invalid.status, 422);
  });
});

test("settings persist automation switches and reschedule jobs", async () => {
  await withApi(async (api) => {
    const initial = await api.get("/api/settings");
    assert.equal(initial.status, 200);
    const initialBody = (await initial.json()) as { settings: Settings };
    assert.equal(initialBody.settings.automations.briefing.enabled, true);
    assert.equal(initialBody.settings.automations.briefing.time, "07:30");

    const patched = await api.send("/api/settings", "PATCH", {
      briefing: { enabled: false, time: "08:15" },
    });
    assert.equal(patched.status, 200);
    const settings = ((await patched.json()) as { settings: Settings }).settings;
    assert.equal(settings.automations.briefing.enabled, false);
    assert.equal(settings.automations.briefing.time, "08:15");

    const job = api.fixture.database.getJob("daily-briefing");
    assert.equal(job?.enabled, false);
    assert.equal(job?.nextRunAt, null);
    const saved = JSON.parse(readFileSync(api.fixture.paths.config, "utf8")) as {
      briefingEnabled: boolean;
      briefingTime: string;
    };
    assert.equal(saved.briefingEnabled, false);
    assert.equal(saved.briefingTime, "08:15");

    const invalid = await api.send("/api/settings", "PATCH", {
      briefing: { time: "25:00" },
    });
    assert.equal(invalid.status, 422);

    const reenabled = await api.send("/api/settings", "PATCH", {
      briefing: { enabled: true, time: "07:45" },
    });
    assert.equal(reenabled.status, 200);
    const enabledSettings = ((await reenabled.json()) as { settings: Settings }).settings;
    assert.equal(enabledSettings.automations.briefing.enabled, true);
    assert.equal(enabledSettings.automations.briefing.time, "07:45");
    const enabledJob = api.fixture.database.getJob("daily-briefing");
    assert.equal(enabledJob?.enabled, true);
    assert.ok(enabledJob?.nextRunAt);
  });
});

test("ideas write Obsidian notes and search keeps library results separate", async () => {
  await withApi(async (api) => {
    const idea = await api.send("/api/ideas", "POST", {
      title: "可控世界模型",
      body: "研究可控世界模型的评估方法。",
      tags: ["世界模型", "评估"],
    });
    assert.equal(idea.status, 201);
    const ideaBody = (await idea.json()) as {
      idea: { relativePath: string; openUrl: string | null };
    };
    const notePath = join(api.fixture.vault, `${ideaBody.idea.relativePath}.md`);
    assert.ok(existsSync(notePath));
    assert.match(readFileSync(notePath, "utf8"), /评估方法/);
    assert.match(ideaBody.idea.openUrl ?? "", /^obsidian:\/\/open\?path=/);

    const search = await api.get("/api/search?q=%E4%B8%96%E7%95%8C%E6%A8%A1%E5%9E%8B");
    assert.equal(search.status, 200);
    const searchBody = (await search.json()) as {
      items: Array<{ type: string; title: string; openTarget: string | null }>;
    };
    assert.ok(searchBody.items.some((item) => item.type === "paper"));
    assert.ok(searchBody.items.some((item) => item.type === "idea"));

    const types = await api.get("/api/search?q=%E4%B8%96%E7%95%8C%E6%A8%A1%E5%9E%8B&types=idea");
    const typesBody = (await types.json()) as { items: Array<{ type: string }> };
    assert.deepEqual(typesBody.items.map((item) => item.type), ["idea"]);

    const empty = await api.get("/api/search?q=");
    assert.equal(empty.status, 400);
  });
});

test("agent messages persist a conversation that later turns continue", async () => {
  await withApi(async (api) => {
    const first = await api.send("/api/agent/messages", "POST", { message: "今天做什么？" });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as {
      answer: string;
      references: unknown[];
      conversationId: string;
      conversation: ConversationDto;
      messages: TranscriptMessageDto[];
    };
    assert.equal(firstBody.answer, "回答：今天做什么？");
    assert.deepEqual(firstBody.references, []);
    assert.ok(firstBody.conversationId);
    assert.equal(firstBody.conversation.title, "今天做什么？");
    assert.equal(firstBody.messages.length, 2);

    const list = await api.get("/api/conversations?status=active");
    const listBody = (await list.json()) as { items: ConversationDto[] };
    assert.equal(listBody.items.length, 1);
    assert.equal(listBody.items[0]?.id, firstBody.conversationId);

    const second = await api.send("/api/agent/messages", "POST", {
      conversationId: firstBody.conversationId,
      message: "接着上一条",
    });
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as {
      conversationId: string;
      conversation: ConversationDto;
    };
    assert.equal(secondBody.conversationId, firstBody.conversationId);
    assert.equal(secondBody.conversation.messageCount, 4);

    const transcript = await api.get(`/api/conversations/${firstBody.conversationId}/messages`);
    assert.equal(transcript.status, 200);
    const transcriptBody = (await transcript.json()) as ConversationTranscriptResponse;
    assert.deepEqual(
      transcriptBody.messages.map((message) => message.role),
      ["user", "assistant", "user", "assistant"],
    );
    assert.equal(transcriptBody.messages[3]?.text, "回答：接着上一条");

    const empty = await api.send("/api/agent/messages", "POST", { message: "  " });
    assert.equal(empty.status, 422);

    const missing = await api.send(
      "/api/conversations/00000000-0000-4000-8000-000000000000/messages",
      "POST",
      { message: "还在吗" },
    );
    assert.equal(missing.status, 404);
  });
});

test("conversations can be created, archived, and deleted", async () => {
  await withApi(async (api) => {
    const created = await api.send("/api/conversations", "POST", {});
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as { conversation: ConversationDto };
    const id = createdBody.conversation.id;
    assert.equal(createdBody.conversation.status, "active");
    assert.equal(createdBody.conversation.title, null);

    const renamed = await api.send(`/api/conversations/${id}`, "PATCH", { title: "实验讨论" });
    assert.equal(renamed.status, 200);
    assert.equal(
      ((await renamed.json()) as { conversation: ConversationDto }).conversation.title,
      "实验讨论",
    );

    const archived = await api.send(`/api/conversations/${id}`, "PATCH", { status: "archived" });
    assert.equal(archived.status, 200);
    assert.equal(
      ((await archived.json()) as { conversation: ConversationDto }).conversation.status,
      "archived",
    );

    const blocked = await api.send(`/api/conversations/${id}/messages`, "POST", { message: "继续" });
    assert.equal(blocked.status, 409);

    const active = await api.get("/api/conversations?status=active");
    assert.deepEqual(((await active.json()) as { items: ConversationDto[] }).items, []);

    const deleted = await api.send(`/api/conversations/${id}`, "DELETE");
    assert.equal(deleted.status, 200);
    const missing = await api.get(`/api/conversations/${id}/messages`);
    assert.equal(missing.status, 404);
    const removedAgain = await api.send(`/api/conversations/${id}`, "DELETE");
    assert.equal(removedAgain.status, 404);
  });
});

test("memories can be created, deduplicated, edited, and deleted", async () => {
  await withApi(async (api) => {
    const created = await api.send("/api/memories", "POST", {
      kind: "preference",
      content: "偏好上午阅读论文",
      importance: 4,
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as {
      memory: { id: string; importance: number };
      created: boolean;
    };
    assert.equal(createdBody.created, true);
    assert.equal(createdBody.memory.importance, 4);

    const duplicate = await api.send("/api/memories", "POST", {
      kind: "preference",
      content: "偏好上午阅读论文",
    });
    assert.equal(duplicate.status, 200);
    assert.equal(((await duplicate.json()) as { created: boolean }).created, false);

    const list = await api.get(`/api/memories?query=${encodeURIComponent("上午")}`);
    assert.equal(list.status, 200);
    const items = ((await list.json()) as {
      items: Array<{ id: string; content: string; importance: number }>;
    }).items;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.content, "偏好上午阅读论文");

    const updated = await api.send(`/api/memories/${createdBody.memory.id}`, "PATCH", {
      importance: 5,
      content: "偏好上午阅读和写作",
    });
    assert.equal(updated.status, 200);
    assert.equal(
      ((await updated.json()) as { memory: { content: string; importance: number } }).memory.content,
      "偏好上午阅读和写作",
    );

    const deleted = await api.send(`/api/memories/${createdBody.memory.id}`, "DELETE");
    assert.equal(deleted.status, 200);
    const empty = await api.get("/api/memories");
    assert.deepEqual(((await empty.json()) as { items: unknown[] }).items, []);
    const again = await api.send(`/api/memories/${createdBody.memory.id}`, "DELETE");
    assert.equal(again.status, 200, "delete is idempotent for an already removed memory");
    const missing = await api.send("/api/memories/00000000-0000-4000-8000-000000000000", "DELETE");
    assert.equal(missing.status, 404);

    const invalid = await api.send("/api/memories", "POST", { kind: "nope", content: "x" });
    assert.equal(invalid.status, 422);
  });
});

test("expired memories are excluded from the list", async () => {
  await withApi(async (api) => {
    const past = await api.send("/api/memories", "POST", {
      kind: "experience",
      content: "已经过期的安排",
      validUntil: "2026-10-01T00:00:00.000Z",
    });
    assert.equal(past.status, 201);
    const list = await api.get("/api/memories");
    assert.deepEqual(((await list.json()) as { items: unknown[] }).items, []);
  });
});

test("scheduling a task is backed by a resumable workflow run", async () => {
  await withApi(async (api) => {
    const staged = await api.send(`/api/tasks/${api.fixture.draftTaskId}/schedule`, "POST", {
      startAt: "2026-10-30T01:00:00Z",
      endAt: "2026-10-30T02:00:00Z",
    });
    assert.equal(staged.status, 201);
    const body = (await staged.json()) as { approval: Approval; workflowRunId: string };
    assert.ok(body.workflowRunId);

    const run = await api.get(`/api/workflows/${body.workflowRunId}`);
    assert.equal(run.status, 200);
    const runBody = (await run.json()) as { run: WorkflowRunDto; steps: WorkflowStepDto[] };
    assert.equal(runBody.run.status, "waiting_for_user");
    assert.equal(runBody.run.kind, "task.schedule");
    assert.equal(runBody.run.state.approvalId, body.approval.id);
    assert.deepEqual(runBody.steps.map((step) => step.status), ["succeeded"]);

    const pendingResume = await api.send(`/api/workflows/${body.workflowRunId}/resume`, "POST");
    assert.equal(pendingResume.status, 200);
    const pendingBody = (await pendingResume.json()) as { run: WorkflowRunDto; steps: WorkflowStepDto[] };
    assert.equal(pendingBody.run.status, "waiting_for_user");
    assert.deepEqual(pendingBody.steps.map((step) => step.status), ["succeeded", "pending"]);
    assert.equal(api.fixture.createdEvents.length, 0, "nothing was written to the calendar yet");

    const approved = await api.send(`/api/approvals/${body.approval.id}/approve`, "POST");
    assert.equal(approved.status, 200);

    const after = await api.get(`/api/workflows/${body.workflowRunId}`);
    const afterBody = (await after.json()) as { run: WorkflowRunDto; steps: WorkflowStepDto[] };
    assert.equal(afterBody.run.status, "succeeded");
    assert.deepEqual(afterBody.steps.map((step) => step.status), ["succeeded", "succeeded"]);
    assert.equal(api.fixture.database.getResearchTask(api.fixture.draftTaskId)?.status, "planned");

    const listed = await api.get("/api/workflows?status=succeeded");
    const listedBody = (await listed.json()) as { items: WorkflowRunDto[] };
    assert.ok(listedBody.items.some((item) => item.id === body.workflowRunId));
  });
});

test("a workflow run can be cancelled and terminal runs reject resume", async () => {
  await withApi(async (api) => {
    const staged = await api.send(`/api/tasks/${api.fixture.draftTaskId}/schedule`, "POST", {
      startAt: "2026-10-30T03:00:00Z",
      endAt: "2026-10-30T04:00:00Z",
    });
    const body = (await staged.json()) as { workflowRunId: string };

    const cancelled = await api.send(`/api/workflows/${body.workflowRunId}/cancel`, "POST");
    assert.equal(cancelled.status, 200);
    assert.equal(((await cancelled.json()) as { run: WorkflowRunDto }).run.status, "cancelled");

    const resume = await api.send(`/api/workflows/${body.workflowRunId}/resume`, "POST");
    assert.equal(resume.status, 409);
    const missing = await api.get("/api/workflows/00000000-0000-4000-8000-000000000000");
    assert.equal(missing.status, 404);
  });
});

test("rejected approvals cannot be approved later", async () => {
  await withApi(async (api) => {
    const rejected = await api.send(`/api/approvals/${api.fixture.actionId}/reject`, "POST");
    assert.equal(rejected.status, 200);
    assert.equal(((await rejected.json()) as { approval: Approval }).approval.status, "rejected");

    const approved = await api.send(`/api/approvals/${api.fixture.actionId}/approve`, "POST");
    assert.equal(approved.status, 409);
    assert.equal(api.fixture.createdEvents.length, 0);
  });
});

test("approval history lists failed actions first and failed actions can be retried", async () => {
  await withApi(async (api) => {
    const failed = api.fixture.database.stageWorkflowAction(
      "calendar.create",
      {
        title: "需要重试的任务",
        startAt: "2026-10-30T09:00:00.000Z",
        endAt: "2026-10-30T10:00:00.000Z",
        taskId: api.fixture.draftTaskId,
      },
      NOW,
    );
    api.fixture.database.approveWorkflowAction(failed.id, NOW);
    api.fixture.database.failWorkflowAction(failed.id, "Calendar 暂时不可用。");

    const history = await api.get("/api/approvals/history?limit=10");
    assert.equal(history.status, 200);
    const historyBody = (await history.json()) as { items: Approval[] };
    assert.equal(historyBody.items.length, 1);
    assert.equal(historyBody.items[0]?.id, failed.id);
    assert.equal(historyBody.items[0]?.status, "failed");
    assert.equal(historyBody.items[0]?.error, "Calendar 暂时不可用。");
    assert.equal(
      historyBody.items.some((item) => item.id === api.fixture.actionId),
      false,
      "pending actions stay in the approval queue rather than history",
    );

    const retried = await api.send(`/api/approvals/${failed.id}/approve`, "POST");
    assert.equal(retried.status, 200);
    assert.equal(((await retried.json()) as { approval: Approval }).approval.status, "executed");
    assert.equal(api.fixture.createdEvents.length, 1);

    const limited = await api.get("/api/approvals/history?limit=1");
    assert.equal(limited.status, 200);
    assert.equal(((await limited.json()) as { items: Approval[] }).items.length, 1);

    const invalid = await api.get("/api/approvals/history?limit=0");
    assert.equal(invalid.status, 422);
  });
});

type ApiFixture = {
  baseUrl: string;
  token: string;
  paths: AppPaths;
  database: AppDatabase;
  config: AppConfig;
  vault: string;
  draftTaskId: string;
  plannedTaskId: string;
  lectureId: string;
  actionId: string;
  createdEvents: CalendarEvent[];
};

type ApiClient = {
  fixture: ApiFixture;
  get(path: string): Promise<Response>;
  send(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<Response>;
  waitOperation(id: string): Promise<OperationDto>;
};

type FixtureOptions = {
  calendar?: CalendarSource;
  knowledge?: LocalServerOptions["knowledge"];
  agent?: LocalServerOptions["agent"];
};

async function withApi(
  operation: (api: ApiClient) => Promise<void>,
  options: FixtureOptions = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "person-agent-api-test-"));
  const vault = join(root, "vault");
  mkdirSync(vault, { recursive: true });
  const paths: AppPaths = {
    root,
    config: join(root, "config.json"),
    database: join(root, "agent.db"),
    secrets: join(root, "secrets.dpapi"),
    log: join(root, "worker.log"),
  };
  const config: AppConfig = {
    timezone: "Asia/Shanghai",
    briefingTime: "07:30",
    briefingEnabled: true,
    thinkingLevel: "low",
    knowledgeVaultPath: vault,
    knowledgeDigestTime: "22:30",
    knowledgeDigestEnabled: true,
    location: { city: "上海", latitude: 31.2304, longitude: 121.4737, timezone: "Asia/Shanghai" },
  };
  writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const database = new AppDatabase(paths.database);
  const createdEvents: CalendarEvent[] = [];
  const approvalExecutor: ApprovalExecutor = {
    async create(input) {
      const event = eventWith("created-event-1", input.title, input.startAt, input.endAt);
      createdEvents.push(event);
      return event;
    },
    async update(id, input) {
      const event = eventWith(id, input.title, input.startAt, input.endAt);
      createdEvents.push(event);
      return event;
    },
  };
  const seeded = seed(database, config);
  const server = await startLocalServer({
    token: TOKEN,
    paths,
    config,
    database,
    now: () => NOW,
    calendar:
      options.calendar ??
      ({
        async list() {
          return [
            eventWith("evt-1", "阅读论文", "2026-10-30T02:00:00.000Z", "2026-10-30T03:00:00.000Z"),
            eventWith("evt-2", "临时组会", "2026-10-30T06:00:00.000Z", "2026-10-30T07:00:00.000Z"),
          ];
        },
      } satisfies CalendarSource),
    weather: async (location) => ({
      location,
      current: {
        time: "2026-10-30T10:00",
        temperature: 21,
        apparentTemperature: 20,
        precipitationProbability: 10,
        windSpeed: 8,
        weatherCode: 0,
        condition: "晴",
      },
      hourly: [],
    }),
    probes: {
      zotero: async () => ({ state: "available", updatedAt: null, message: null }),
      worker: () => ({ state: "stopped", lastRunAt: null }),
      deepSeek: async () => ({ state: "not_configured", updatedAt: null, message: null }),
    },
    approvalExecutor,
    ...(options.knowledge
      ? { knowledge: options.knowledge }
      : {
          knowledge: {
            async sync() {
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
              return { added: 1 };
            },
            async digest() {
              return { digest: true };
            },
          },
        }),
    agent:
      options.agent ??
      (async (request, input) => {
        const conversation = input.conversationId
          ? request.database.getAgentConversation(input.conversationId)
          : request.database.createAgentConversation(undefined, NOW);
        if (!conversation) throw new ConversationNotFoundError(input.conversationId!);
        if (conversation.status === "archived") throw new ConversationArchivedError(conversation.id);
        const titled = conversation.title
          ? conversation
          : request.database.updateAgentConversation(
              conversation.id,
              { title: conversationTitleFrom(input.message) },
              NOW,
            );
        const persisted = request.database.appendAgentTranscript(
          titled.id,
          [
            { role: "user", message: { role: "user", content: input.message, timestamp: NOW.getTime() } },
            {
              role: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "text", text: `回答：${input.message}` }],
                stopReason: "stop",
                timestamp: NOW.getTime(),
              },
            },
          ],
          NOW,
        );
        return {
          conversation: request.database.getAgentConversation(titled.id) ?? titled,
          answer: `回答：${input.message}`,
          references: [],
          messages: persisted,
        };
      }),
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const fixture: ApiFixture = {
    baseUrl,
    token: TOKEN,
    paths,
    database,
    config,
    vault,
    createdEvents,
    ...seeded,
  };
  const client: ApiClient = {
    fixture,
    get: (path) =>
      fetch(`${baseUrl}${path}`, {
        headers: { "X-Person-Agent-Token": TOKEN },
      }),
    send: (path, method, body) =>
      fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          "X-Person-Agent-Token": TOKEN,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    waitOperation: async (id) => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const response = await fetch(`${baseUrl}/api/operations/${id}`, {
          headers: { "X-Person-Agent-Token": TOKEN },
        });
        assert.equal(response.status, 200);
        const value = (await response.json()) as { operation: OperationDto };
        if (value.operation.status === "succeeded" || value.operation.status === "failed") {
          return value.operation;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      throw new Error("operation did not finish");
    },
  };
  try {
    await operation(client);
  } finally {
    await server.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function seed(database: AppDatabase, config: AppConfig) {
  const draft = database.createResearchTask(
    { title: "整理实验结果", estimatedMinutes: 60, priority: "high" },
    NOW,
  );
  const planned = database.createResearchTask(
    { title: "阅读论文", estimatedMinutes: 60 },
    NOW,
  );
  database.updateResearchTask(
    planned.id,
    {
      status: "planned",
      plannedStart: "2026-10-30T02:00:00.000Z",
      plannedEnd: "2026-10-30T03:00:00.000Z",
      calendarEventId: "evt-1",
    },
    NOW,
  );
  const lecture = database.createLecture(
    {
      title: "组会",
      startAt: "2026-10-30T06:00:00.000Z",
      endAt: "2026-10-30T07:00:00.000Z",
      location: "会议室",
    },
    NOW,
  );
  const action = database.stageWorkflowAction(
    "calendar.create",
    {
      title: "整理实验结果",
      startAt: "2026-10-30T07:00:00.000Z",
      endAt: "2026-10-30T08:00:00.000Z",
      taskId: draft.id,
    },
    NOW,
  );

  database.upsertZoteroPaper(
    paper("PAPER-COMPLETE", "世界模型综述"),
    NOW,
  );
  database.saveZoteroAnalysis(
    "PAPER-COMPLETE",
    {
      direction: "世界模型",
      results: "综述",
      limitations: "缺少实证",
      basis: "全文",
      truncated: true,
    },
    "complete",
    NOW,
  );
  database.upsertZoteroPaper(paper("PAPER-PARTIAL", "摘要论文"), NOW);
  database.saveZoteroAnalysis(
    "PAPER-PARTIAL",
    { direction: "方向", results: "结果", limitations: "不足", basis: "摘要" },
    "partial",
    NOW,
  );
  database.upsertZoteroPaper(paper("PAPER-RETRY", "重试论文"), NOW);
  database.recordZoteroAnalysisFailure("PAPER-RETRY", "timeout", NOW);
  database.upsertZoteroPaper(paper("PAPER-PENDING", "待分析论文"), NOW);

  database.ensureDailyBriefing(config, NOW);
  database.ensureKnowledgeDigest(config, NOW);
  return {
    draftTaskId: draft.id,
    plannedTaskId: planned.id,
    lectureId: lecture.id,
    actionId: action.id,
  };
}

function paper(key: string, title: string) {
  return {
    key,
    version: 1,
    itemType: "journalArticle",
    title,
    creators: [{ creatorType: "author", firstName: "Ada", lastName: "Lovelace", name: "" }],
    date: "2026",
    abstract: "摘要内容",
    doi: null,
    url: null,
    tags: ["世界模型"],
  };
}

function eventWith(id: string, title: string, start: string, end: string): CalendarEvent {
  return {
    id,
    calendar: "primary",
    title,
    description: null,
    location: null,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    allDay: false,
    status: "confirmed",
    attendees: [],
  };
}
