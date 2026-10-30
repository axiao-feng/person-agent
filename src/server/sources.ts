import { GoogleService, type CalendarEvent } from "../integrations/google.js";
import { HttpZoteroClient } from "../knowledge/zotero.js";
import type { AppPaths } from "../paths.js";
import { NotConfiguredError, safeErrorMessage } from "./errors.js";
import type { SourceStatus } from "./types.js";

export type CalendarSource = {
  list(start: Date, end: Date, signal: AbortSignal): Promise<CalendarEvent[]>;
};

export function defaultCalendarSource(paths: AppPaths): CalendarSource {
  return {
    async list(start, end, signal) {
      if (!(await GoogleService.isConnected(paths))) {
        throw new NotConfiguredError("Google 尚未连接。");
      }
      const google = await GoogleService.create(paths);
      return google.listCalendarEvents(start.toISOString(), end.toISOString(), 100, signal);
    },
  };
}

export async function probeZotero(): Promise<SourceStatus> {
  try {
    const client = new HttpZoteroClient({ timeoutMs: 3_000 });
    await client.listTopItems({ start: 0, limit: 1 });
    return { state: "available", updatedAt: new Date().toISOString(), message: null };
  } catch (error) {
    return {
      state: "unavailable",
      updatedAt: null,
      message: safeErrorMessage(error, "Zotero 本地 API 不可用。"),
    };
  }
}
