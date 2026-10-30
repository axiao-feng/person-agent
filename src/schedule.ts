export type JobSchedule =
  | { kind: "once"; at: string }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; time: string; weekdays: number[] };

export function validateSchedule(schedule: JobSchedule): void {
  if (schedule.kind === "once") {
    parseInstant(schedule.at);
    return;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
    throw new Error("提醒时间必须使用 HH:mm 格式。");
  }
  if (schedule.kind === "weekly") {
    if (!schedule.weekdays.length || schedule.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
      throw new Error("每周提醒的 weekdays 必须是 1（周一）到 7（周日）。");
    }
  }
}

export function parseInstant(value: string): Date {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error("日期时间必须包含时区偏移，例如 2026-09-21T19:00:00+08:00。");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("日期时间无效。");
  return date;
}

export function nextOccurrence(
  schedule: JobSchedule,
  after: Date,
  timezone: string,
): Date | null {
  validateSchedule(schedule);
  if (schedule.kind === "once") {
    const at = parseInstant(schedule.at);
    return at.getTime() > after.getTime() ? at : null;
  }

  const [hourText, minuteText] = schedule.time.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const local = zonedParts(after, timezone);
  for (let offset = 0; offset <= 8; offset += 1) {
    const day = addLocalDays(local, offset);
    if (schedule.kind === "weekly" && !schedule.weekdays.includes(isoWeekday(day))) continue;
    const candidate = zonedTimeToUtc({ ...day, hour, minute }, timezone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error("无法计算下一次提醒时间。");
}

export function localDayRange(date: Date, timezone: string): { start: Date; end: Date } {
  const local = zonedParts(date, timezone);
  const startLocal = { ...local, hour: 0, minute: 0 };
  const nextLocal = { ...addLocalDays(startLocal, 1), hour: 0, minute: 0 };
  return {
    start: zonedTimeToUtc(startLocal, timezone),
    end: zonedTimeToUtc(nextLocal, timezone),
  };
}

/** Calendar-day range for a YYYY-MM-DD key in the configured IANA timezone. */
export function localDateRange(dateKey: string, timezone: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) throw new Error("日期必须使用 YYYY-MM-DD 格式。");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error("日期无效。");
  }
  let start: Date;
  let end: Date;
  try {
    const startLocal = { year, month, day, hour: 0, minute: 0, second: 0 };
    const nextLocal = { ...addLocalDays(startLocal, 1), hour: 0, minute: 0, second: 0 };
    start = zonedTimeToUtc(startLocal, timezone);
    end = zonedTimeToUtc(nextLocal, timezone);
  } catch {
    throw new Error(`无效时区：${timezone}`);
  }
  return { start, end };
}

/** Local calendar date in the form YYYY-MM-DD. */
export function localDateKey(date: Date, timezone: string): string {
  const local = zonedParts(date, timezone);
  return `${local.year}-${pad(local.month)}-${pad(local.day)}`;
}

/** Local wall-clock time in the form HHmmss, used for stable note names. */
export function localClockKey(date: Date, timezone: string): string {
  const local = zonedParts(date, timezone);
  return `${pad(local.hour)}${pad(local.minute)}${pad(local.second)}`;
}

export type BusyInterval = { start: string; end: string };
export type FreeSlot = { start: string; end: string; availableMinutes: number };

export function findFreeSlots(input: {
  start: string;
  end: string;
  durationMinutes: number;
  timezone: string;
  busy: BusyInterval[];
  dailyStart?: string;
  dailyEnd?: string;
  weekdays?: number[];
  limit?: number;
}): FreeSlot[] {
  const rangeStart = parseInstant(input.start);
  const rangeEnd = parseInstant(input.end);
  if (rangeEnd <= rangeStart) throw new Error("空闲时段查询的结束时间必须晚于开始时间。");
  if (rangeEnd.getTime() - rangeStart.getTime() > 31 * 24 * 60 * 60_000) throw new Error("空闲时段查询范围不能超过 31 天。");
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 5 || input.durationMinutes > 1440) {
    throw new Error("任务时长必须是 5 到 1440 分钟的整数。");
  }
  const [startHour, startMinute] = parseClock(input.dailyStart ?? "09:00");
  const [endHour, endMinute] = parseClock(input.dailyEnd ?? "18:00");
  if (endHour * 60 + endMinute <= startHour * 60 + startMinute) throw new Error("每日结束时间必须晚于开始时间。");
  const weekdays = input.weekdays ?? [1, 2, 3, 4, 5];
  if (!weekdays.length || weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new Error("weekdays 必须是 1（周一）到 7（周日）。");
  }
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 10), 1), 50);
  const busy = input.busy
    .map((item) => ({ start: parseInstant(item.start).getTime(), end: parseInstant(item.end).getTime() }))
    .filter((item) => item.end > item.start)
    .sort((left, right) => left.start - right.start);
  const slots: FreeSlot[] = [];
  const firstLocal = zonedParts(rangeStart, input.timezone);
  for (let offset = 0; offset <= 32 && slots.length < limit; offset += 1) {
    const day = addLocalDays(firstLocal, offset);
    const dayStart = zonedTimeToUtc({ ...day, hour: 0, minute: 0 }, input.timezone);
    if (dayStart >= rangeEnd) break;
    if (!weekdays.includes(isoWeekday(day))) continue;
    const workStart = Math.max(
      rangeStart.getTime(),
      zonedTimeToUtc({ ...day, hour: startHour, minute: startMinute }, input.timezone).getTime(),
    );
    const workEnd = Math.min(
      rangeEnd.getTime(),
      zonedTimeToUtc({ ...day, hour: endHour, minute: endMinute }, input.timezone).getTime(),
    );
    if (workEnd <= workStart) continue;
    let cursor = workStart;
    for (const interval of busy) {
      if (interval.end <= cursor || interval.start >= workEnd) continue;
      const gapEnd = Math.min(interval.start, workEnd);
      if (gapEnd - cursor >= input.durationMinutes * 60_000) slots.push(freeSlot(cursor, gapEnd));
      cursor = Math.max(cursor, interval.end);
      if (cursor >= workEnd || slots.length >= limit) break;
    }
    if (slots.length < limit && workEnd - cursor >= input.durationMinutes * 60_000) slots.push(freeSlot(cursor, workEnd));
  }
  return slots.slice(0, limit);
}

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function zonedParts(date: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function zonedTimeToUtc(local: LocalParts, timezone: string): Date {
  const target = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  let timestamp = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(new Date(timestamp), timezone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const adjustment = target - actualAsUtc;
    timestamp += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(timestamp);
}

function addLocalDays(local: LocalParts, count: number): LocalParts {
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day + count));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: local.hour,
    minute: local.minute,
    second: local.second,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function isoWeekday(local: Pick<LocalParts, "year" | "month" | "day">): number {
  const day = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
  return day === 0 ? 7 : day;
}

function parseClock(value: string): [number, number] {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("每日工作时间必须使用 HH:mm 格式。");
  const [hour, minute] = value.split(":").map(Number);
  return [hour!, minute!];
}

function freeSlot(start: number, end: number): FreeSlot {
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    availableMinutes: Math.floor((end - start) / 60_000),
  };
}
