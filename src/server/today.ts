import type { AppConfig } from "../config.js";
import {
  AppDatabase,
  KNOWLEDGE_DIGEST_JOB_ID,
  type JobRun,
  type ResearchTask,
  type ScheduledJob,
} from "../database.js";
import type { CalendarEvent } from "../integrations/google.js";
import { getWeather, type WeatherForecast, type WeatherLocation } from "../integrations/weather.js";
import { localDateKey, localDateRange, nextOccurrence } from "../schedule.js";
import { approvalDto } from "./approval-data.js";
import { ApiError, NotConfiguredError, safeErrorMessage } from "./errors.js";
import { paperSummary } from "./paper-data.js";
import type { CalendarSource } from "./sources.js";
import type {
  Approval,
  FocusItem,
  FocusReasonCode,
  SourceStatus,
  TimelineItem,
  TodayResponse,
  WeatherSummary,
} from "./types.js";

export type TodayDependencies = {
  config: AppConfig;
  database: AppDatabase;
  calendar: CalendarSource;
  weather?: (location: WeatherLocation, signal: AbortSignal) => Promise<WeatherForecast>;
  now?: () => Date;
  requestId: string;
  date?: string;
};

const DAILY_BRIEFING_JOB_ID = "daily-briefing";
const DAY_TIMEOUT_MS = 15_000;

export async function buildTodaySnapshot(dependencies: TodayDependencies): Promise<TodayResponse> {
  const now = (dependencies.now ?? (() => new Date()))();
  const calendarSource = dependencies.calendar;
  const weatherProvider = dependencies.weather ?? getWeather;
  const requestId = dependencies.requestId;
  const config = dependencies.config;
  const database = dependencies.database;

  const date = dependencies.date ?? localDateKey(now, config.timezone);
  let range: { start: Date; end: Date };
  try {
    range = localDateRange(date, config.timezone);
  } catch (error) {
    const message = safeErrorMessage(error, "日期无效。");
    throw new ApiError(400, "VALIDATION_FAILED", message, false, { date: message });
  }

  const tasks = database.listResearchTasks();
  const lectures = database.listLectures(range.start, range.end);
  const pendingActions = database.listWorkflowActions("pending");
  const papers = database.listZoteroPapersTouchedBetween(range.start, range.end, 5);
  const isConnected = Boolean(config.location);
  const timeout = AbortSignal.timeout(DAY_TIMEOUT_MS);

  const [calendarResult, weatherResult] = await Promise.allSettled([
    calendarSource.list(range.start, range.end, timeout),
    isConnected && config.location
      ? weatherProvider(config.location, timeout)
      : Promise.reject(new NotConfiguredError("未配置城市。")),
  ]);

  const calendarStatus: SourceStatus =
    calendarResult.status === "fulfilled"
      ? { state: "available", updatedAt: now.toISOString(), message: null }
      : sourceFailure(calendarResult.reason, "Calendar 数据暂时不可用。");
  const weatherStatus: SourceStatus =
    weatherResult.status === "fulfilled"
      ? { state: "available", updatedAt: now.toISOString(), message: null }
      : sourceFailure(weatherResult.reason, "天气数据暂时不可用。");

  const calendarEvents = calendarResult.status === "fulfilled" ? calendarResult.value : [];
  const weather =
    weatherResult.status === "fulfilled"
      ? toWeatherSummary(weatherResult.value, config)
      : null;

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const approvals = pendingActions
    .map((action) => {
      const taskId = typeof action.payload.taskId === "string" ? action.payload.taskId : undefined;
      return approvalDto(action, taskId ? taskById.get(taskId) : undefined);
    })
    .filter((approval): approval is Approval => approval !== undefined);
  const knowledgeItems = papers.map((paper) => paperSummary(paper, now));
  const timeline = buildTimeline({
    events: calendarEvents,
    lectures,
    tasks,
    approvals,
    jobs: [DAILY_BRIEFING_JOB_ID, KNOWLEDGE_DIGEST_JOB_ID]
      .map((id) => database.getJob(id))
      .filter((job): job is NonNullable<typeof job> => Boolean(job)),
    latestRuns: new Map(
      [DAILY_BRIEFING_JOB_ID, KNOWLEDGE_DIGEST_JOB_ID].map((id) => [id, database.getLatestJobRun(id)]),
    ),
    range,
    timezone: config.timezone,
    now,
  });

  const sources: Record<string, SourceStatus> = {
    tasks: localSource(),
    lectures: localSource(),
    knowledge: localSource(),
    approvals: localSource(),
    calendar: calendarStatus,
    weather: weatherStatus,
  };
  const partial =
    calendarStatus.state === "unavailable" || weatherStatus.state === "unavailable";

  return {
    requestId,
    generatedAt: now.toISOString(),
    date,
    timezone: config.timezone,
    status: partial ? "partial" : "success",
    sources,
    weather,
    focusItems: buildFocusItems(tasks, lectures, range),
    timeline,
    knowledgeItems,
    approvals,
  };
}

function sourceFailure(reason: unknown, fallback: string): SourceStatus {
  if (reason instanceof NotConfiguredError) {
    return { state: "not_configured", updatedAt: null, message: safeErrorMessage(reason, fallback) };
  }
  return { state: "unavailable", updatedAt: null, message: safeErrorMessage(reason, fallback) };
}

function localSource(): SourceStatus {
  return { state: "available", updatedAt: null, message: null };
}

function toWeatherSummary(forecast: WeatherForecast, config: AppConfig): WeatherSummary {
  return {
    city: config.location?.city ?? forecast.location.city,
    condition: forecast.current.condition,
    temperature: forecast.current.temperature,
    apparentTemperature: forecast.current.apparentTemperature,
    precipitationProbability: forecast.current.precipitationProbability,
    windSpeed: forecast.current.windSpeed,
  };
}

type TimelineInput = {
  events: CalendarEvent[];
  lectures: Awaited<ReturnType<AppDatabase["listLectures"]>>;
  tasks: ResearchTask[];
  approvals: Approval[];
  jobs: Array<NonNullable<ReturnType<AppDatabase["getJob"]>>>;
  latestRuns: Map<string, JobRun | undefined>;
  range: { start: Date; end: Date };
  timezone: string;
  now: Date;
};

function buildTimeline(input: TimelineInput): TimelineItem[] {
  const items: TimelineItem[] = [];
  const plannedTasks = input.tasks.filter(
    (task) =>
      (task.status === "planned" || task.status === "in_progress") &&
      task.plannedStart !== null &&
      task.plannedEnd !== null &&
      inRange(task.plannedStart, input.range),
  );
  const taskByEventId = new Map<string, ResearchTask>();
  for (const task of plannedTasks) {
    if (task.calendarEventId) taskByEventId.set(task.calendarEventId, task);
  }

  const includedEventIds = new Set<string>();
  for (const event of input.events) {
    if (event.status === "cancelled") continue;
    const times = eventTimes(event, input.timezone);
    if (!times) continue;
    includedEventIds.add(event.id);
    const linkedTask = taskByEventId.get(event.id);
    items.push({
      id: `google:${event.id}`,
      source: "google",
      title: event.title,
      startAt: times.startAt,
      endAt: times.endAt,
      allDay: event.allDay,
      status: event.status,
      detail: event.location ?? event.calendar ?? null,
      linkedObjectId: linkedTask?.id ?? null,
    });
  }

  for (const task of plannedTasks) {
    if (task.calendarEventId && includedEventIds.has(task.calendarEventId)) continue;
    if (!task.plannedStart) continue;
    items.push({
      id: `task:${task.id}`,
      source: "task",
      title: task.title,
      startAt: task.plannedStart,
      endAt: task.plannedEnd,
      allDay: false,
      status: task.status,
      detail: "已计划任务",
      linkedObjectId: task.id,
    });
  }

  for (const lecture of input.lectures) {
    items.push({
      id: `lecture:${lecture.id}`,
      source: "lecture",
      title: lecture.title,
      startAt: lecture.startAt,
      endAt: lecture.endAt,
      allDay: false,
      status: lecture.status,
      detail: [lecture.location, lecture.speaker].filter(Boolean).join(" · ") || "本地讲座",
      linkedObjectId: lecture.id,
    });
  }

  for (const approval of input.approvals) {
    items.push({
      id: `approval:${approval.id}`,
      source: "approval",
      title: approval.display.title,
      startAt: approval.display.proposedStart,
      endAt: approval.display.proposedEnd,
      allDay: false,
      status: "pending",
      detail: "待审批 · 尚未写入 Calendar",
      linkedObjectId: approval.id,
    });
  }

  for (const job of input.jobs) {
    const occurrence = todayOccurrence(job, input.range);
    if (!occurrence) continue;
    const occurrenceIso = occurrence.toISOString();
    const run = input.latestRuns.get(job.id);
    const status =
      occurrence.getTime() > input.now.getTime()
        ? "scheduled"
        : run?.scheduledFor === occurrenceIso
          ? run.status
          : "missed";
    items.push({
      id: `automation:${job.id}`,
      source: "automation",
      title: job.title,
      startAt: occurrenceIso,
      endAt: null,
      allDay: false,
      status,
      detail: jobRunDetail(run),
      linkedObjectId: job.id,
    });
  }

  return items.sort(
    (left, right) =>
      Number(right.allDay) - Number(left.allDay) ||
      left.startAt.localeCompare(right.startAt) ||
      left.title.localeCompare(right.title),
  );
}

function todayOccurrence(
  job: ScheduledJob,
  range: { start: Date; end: Date },
): Date | undefined {
  if (!job.enabled) return undefined;
  try {
    const occurrence = nextOccurrence(job.schedule, new Date(range.start.getTime() - 1), job.timezone);
    return occurrence && occurrence.getTime() < range.end.getTime() ? occurrence : undefined;
  } catch {
    return undefined;
  }
}

function jobRunDetail(run: JobRun | undefined): string {
  if (!run) return "尚无运行记录";
  switch (run.status) {
    case "delivered":
      return "上次运行成功";
    case "failed":
      return "上次运行失败";
    case "skipped":
      return "上次运行已跳过";
    case "claimed":
      return "上次运行未完成";
  }
}

function eventTimes(
  event: CalendarEvent,
  timezone: string,
): { startAt: string; endAt: string | null } | undefined {
  if (event.allDay) {
    let startAt: string;
    try {
      startAt = localDateRange(event.start, timezone).start.toISOString();
    } catch {
      return undefined;
    }
    let endAt: string | null = null;
    try {
      endAt = localDateRange(event.end, timezone).start.toISOString();
    } catch {
      endAt = null;
    }
    return { startAt, endAt };
  }
  const startAt = isoOrNull(event.start);
  if (!startAt) return undefined;
  return { startAt, endAt: isoOrNull(event.end) };
}

function buildFocusItems(
  tasks: ResearchTask[],
  lectures: Awaited<ReturnType<AppDatabase["listLectures"]>>,
  range: { start: Date; end: Date },
): FocusItem[] {
  const items: FocusItem[] = [];
  const seen = new Set<string>();
  const add = (item: FocusItem): void => {
    const key = `${item.type}:${item.id}`;
    if (items.length >= 3 || seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };
  const sortByDeadline = (left: ResearchTask, right: ResearchTask): number =>
    compareNullableIso(left.deadline, right.deadline) || left.createdAt.localeCompare(right.createdAt);

  tasks
    .filter((task) => task.status === "in_progress")
    .sort(sortByDeadline)
    .forEach((task) => add(taskFocus(task, "in_progress")));

  tasks
    .filter(
      (task) =>
        task.status === "planned" && task.plannedStart !== null && inRange(task.plannedStart, range),
    )
    .sort((left, right) => (left.plannedStart ?? "").localeCompare(right.plannedStart ?? ""))
    .forEach((task) => add(taskFocus(task, "planned_today")));

  tasks
    .filter(
      (task) =>
        isActiveTask(task) &&
        task.deadline !== null &&
        Date.parse(task.deadline) < range.end.getTime(),
    )
    .sort((left, right) => compareNullableIso(left.deadline, right.deadline))
    .forEach((task) =>
      add(
        taskFocus(
          task,
          Date.parse(task.deadline!) < range.start.getTime() ? "overdue" : "due_today",
        ),
      ),
    );

  tasks
    .filter(
      (task) =>
        (task.status === "draft" || task.status === "needs_replan") && task.priority === "high",
    )
    .sort(sortByDeadline)
    .forEach((task) => add(taskFocus(task, "high_priority")));

  lectures
    .filter((lecture) => lecture.requiresPresentation)
    .sort((left, right) => left.startAt.localeCompare(right.startAt))
    .forEach((lecture) =>
      add({
        type: "lecture",
        id: lecture.id,
        title: lecture.title,
        reasonCode: "presentation_today",
        startAt: lecture.startAt,
        endAt: lecture.endAt,
        deadline: null,
      }),
    );

  return items;
}

function taskFocus(task: ResearchTask, reasonCode: FocusReasonCode): FocusItem {
  return {
    type: "task",
    id: task.id,
    title: task.title,
    reasonCode,
    startAt: task.plannedStart,
    endAt: task.plannedEnd,
    deadline: task.deadline,
  };
}

function isActiveTask(task: ResearchTask): boolean {
  return task.status === "draft" || task.status === "planned" || task.status === "in_progress" || task.status === "needs_replan";
}

function inRange(value: string, range: { start: Date; end: Date }): boolean {
  const time = Date.parse(value);
  return !Number.isNaN(time) && time >= range.start.getTime() && time < range.end.getTime();
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function compareNullableIso(left: string | null, right: string | null): number {
  if (left && right) return left.localeCompare(right);
  if (left) return -1;
  if (right) return 1;
  return 0;
}
