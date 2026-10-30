import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";

import { CodeChallengeMethod, OAuth2Client, type Credentials } from "google-auth-library";

import type { AppPaths } from "../paths.js";
import { loadSecrets, saveSecrets, type AppSecrets } from "../secrets.js";
import { extractMimeBody, type GmailPart, type MailAttachment } from "./mime.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

type Header = { name?: string; value?: string };
type GmailMessage = {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart & { headers?: Header[] };
};

export type EmailSummary = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
};

export type EmailDetail = EmailSummary & {
  body: string;
  truncated: boolean;
  attachments: MailAttachment[];
};

export type CalendarEvent = {
  id: string;
  calendar: string;
  title: string;
  description: string | null;
  location: string | null;
  start: string;
  end: string;
  allDay: boolean;
  status: string;
  attendees: Array<{ email: string; responseStatus: string | null }>;
};

export type CalendarEventInput = {
  title: string;
  startAt: string;
  endAt: string;
  description?: string;
  location?: string;
};

export async function connectGoogle(paths: AppPaths, credentialsPath: string): Promise<string> {
  const credentials = loadClientCredentials(credentialsPath);
  const state = randomBytes(32).toString("base64url");
  const callback = await startCallbackServer(state);
  try {
    const client = new OAuth2Client({
      clientId: credentials.clientId,
      ...(credentials.clientSecret ? { clientSecret: credentials.clientSecret } : {}),
      redirectUri: callback.redirectUri,
    });
    const verifier = await client.generateCodeVerifierAsync();
    if (!verifier.codeChallenge) throw new Error("无法生成 Google OAuth PKCE challenge。");
    const url = client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
      scope: GOOGLE_SCOPES,
      state,
      code_challenge: verifier.codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
    openBrowser(url);
    console.log(`如果浏览器没有自动打开，请访问：\n${url}\n`);
    const code = await callback.waitForCode();
    const response = await client.getToken({
      code,
      codeVerifier: verifier.codeVerifier,
      redirect_uri: callback.redirectUri,
    });
    if (!response.tokens.refresh_token) {
      throw new Error("Google 未返回 refresh token。请撤销旧授权后重新运行 setup。");
    }
    client.setCredentials(response.tokens);
    const current = await loadSecrets(paths);
    await saveSecrets(paths, {
      ...current,
      google: {
        clientId: credentials.clientId,
        ...(credentials.clientSecret ? { clientSecret: credentials.clientSecret } : {}),
        tokens: response.tokens,
      },
    });
    return "Google account";
  } catch (error) {
    throw new Error(safeGoogleError(error));
  } finally {
    await callback.close();
  }
}

export class GoogleService {
  private constructor(
    private readonly client: OAuth2Client,
    private readonly paths: AppPaths,
  ) {}

  static async create(paths: AppPaths): Promise<GoogleService> {
    const secrets = await loadSecrets(paths);
    if (!secrets.google) throw new Error("Google 尚未连接，请先运行 person-agent setup。");
    const client = new OAuth2Client({
      clientId: secrets.google.clientId,
      ...(secrets.google.clientSecret ? { clientSecret: secrets.google.clientSecret } : {}),
    });
    client.setCredentials(secrets.google.tokens);
    const service = new GoogleService(client, paths);
    client.on("tokens", (tokens) => void service.persistTokens(tokens).catch(() => undefined));
    return service;
  }

  static async isConnected(paths: AppPaths): Promise<boolean> {
    try {
      return Boolean((await loadSecrets(paths)).google);
    } catch {
      return false;
    }
  }

  async searchEmails(query: string, limit = 10, signal?: AbortSignal): Promise<EmailSummary[]> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 20);
    try {
      const list = await this.client.request<{ messages?: Array<{ id?: string }> }>({
        url: `${GMAIL_API}/messages?q=${encodeURIComponent(query)}&maxResults=${boundedLimit}`,
        signal: signal ?? null,
        timeout: 15_000,
      });
      const messages = await Promise.all(
        (list.data.messages ?? []).map(async ({ id }) => {
          if (!id) return undefined;
          const response = await this.client.request<GmailMessage>({
            url: `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
            signal: signal ?? null,
            timeout: 15_000,
          });
          return summarizeMessage(response.data);
        }),
      );
      return messages.filter((message): message is EmailSummary => Boolean(message));
    } catch (error) {
      throw new Error(safeGoogleError(error));
    }
  }

  async readEmail(id: string, signal?: AbortSignal): Promise<EmailDetail> {
    try {
      const response = await this.client.request<GmailMessage>({
        url: `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=full`,
        signal: signal ?? null,
        timeout: 15_000,
      });
      const summary = summarizeMessage(response.data);
      const content = extractMimeBody(response.data.payload, 20_000);
      return { ...summary, body: content.text, truncated: content.truncated, attachments: content.attachments };
    } catch (error) {
      throw new Error(safeGoogleError(error));
    }
  }

  async listCalendarEvents(
    start: string,
    end: string,
    limit = 100,
    signal?: AbortSignal,
  ): Promise<CalendarEvent[]> {
    const startDate = new Date(start);
    const endDate = new Date(end);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) {
      throw new Error("日程查询时间范围无效。");
    }
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    try {
      const calendarList = await this.client.request<{
        items?: Array<{ id?: string; summary?: string; selected?: boolean; primary?: boolean; deleted?: boolean }>;
      }>({
        url: `${CALENDAR_API}/users/me/calendarList?maxResults=100&showDeleted=false`,
        signal: signal ?? null,
        timeout: 15_000,
      });
      const calendars = (calendarList.data.items ?? [])
        .filter((calendar) => calendar.id && !calendar.deleted && (calendar.primary || calendar.selected !== false))
        .slice(0, 20);
      const results = await Promise.all(
        calendars.map(async (calendar) => {
          const params = new URLSearchParams({
            timeMin: startDate.toISOString(),
            timeMax: endDate.toISOString(),
            singleEvents: "true",
            orderBy: "startTime",
            maxResults: String(boundedLimit),
            showDeleted: "false",
          });
          const response = await this.client.request<{ items?: GoogleCalendarEvent[] }>({
            url: `${CALENDAR_API}/calendars/${encodeURIComponent(calendar.id!)}/events?${params}`,
            signal: signal ?? null,
            timeout: 15_000,
          });
          return (response.data.items ?? []).map((event) => normalizeEvent(event, calendar.summary || calendar.id!));
        }),
      );
      return results
        .flat()
        .sort((left, right) => left.start.localeCompare(right.start))
        .slice(0, boundedLimit);
    } catch (error) {
      throw new Error(safeGoogleError(error));
    }
  }

  async getCalendarEvent(id: string, signal?: AbortSignal): Promise<CalendarEvent | undefined> {
    try {
      const response = await this.client.request<GoogleCalendarEvent>({
        url: `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(id)}`,
        signal: signal ?? null,
        timeout: 15_000,
      });
      return normalizeEvent(response.data, "primary");
    } catch (error) {
      if ((error as { response?: { status?: number } }).response?.status === 404) return undefined;
      throw new Error(safeGoogleError(error));
    }
  }

  async createCalendarEvent(
    input: CalendarEventInput,
    idempotencyId: string,
    signal?: AbortSignal,
  ): Promise<CalendarEvent> {
    const body = calendarEventBody(input);
    const eventId = idempotencyId.replace(/-/g, "").toLowerCase();
    try {
      const response = await this.client.request<GoogleCalendarEvent>({
        url: `${CALENDAR_API}/calendars/primary/events?sendUpdates=none`,
        method: "POST",
        data: { id: eventId, ...body },
        signal: signal ?? null,
        timeout: 15_000,
      });
      return normalizeEvent(response.data, "primary");
    } catch (error) {
      if ((error as { response?: { status?: number } }).response?.status === 409) {
        const existing = await this.getCalendarEvent(eventId, signal);
        if (existing) return existing;
      }
      throw new Error(safeGoogleError(error));
    }
  }

  async updateCalendarEvent(id: string, input: CalendarEventInput, signal?: AbortSignal): Promise<CalendarEvent> {
    try {
      const response = await this.client.request<GoogleCalendarEvent>({
        url: `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=none`,
        method: "PATCH",
        data: calendarEventBody(input),
        signal: signal ?? null,
        timeout: 15_000,
      });
      return normalizeEvent(response.data, "primary");
    } catch (error) {
      throw new Error(safeGoogleError(error));
    }
  }

  private async persistTokens(tokens: Credentials): Promise<void> {
    const current = await loadSecrets(this.paths);
    if (!current.google) return;
    const merged: AppSecrets = {
      ...current,
      google: {
        ...current.google,
        tokens: { ...current.google.tokens, ...tokens },
      },
    };
    await saveSecrets(this.paths, merged);
  }
}

type GoogleCalendarEvent = {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{ email?: string; responseStatus?: string }>;
};

function calendarEventBody(input: CalendarEventInput): Record<string, unknown> {
  const start = new Date(input.startAt);
  const end = new Date(input.endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new Error("日历事件时间范围无效。");
  }
  const title = input.title.trim();
  if (!title || title.length > 200) throw new Error("日历事件标题必须为 1 到 200 个字符。");
  return {
    summary: title,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    ...(input.description?.trim() ? { description: input.description.trim().slice(0, 4_000) } : {}),
    ...(input.location?.trim() ? { location: input.location.trim().slice(0, 500) } : {}),
  };
}

function normalizeEvent(event: GoogleCalendarEvent, calendar: string): CalendarEvent {
  const allDay = Boolean(event.start?.date);
  return {
    id: event.id || "unknown",
    calendar,
    title: event.summary || "（无标题）",
    description: event.description?.slice(0, 2_000) || null,
    location: event.location?.slice(0, 500) || null,
    start: event.start?.dateTime || event.start?.date || "",
    end: event.end?.dateTime || event.end?.date || "",
    allDay,
    status: event.status || "confirmed",
    attendees: (event.attendees ?? [])
      .filter((attendee) => attendee.email)
      .slice(0, 50)
      .map((attendee) => ({ email: attendee.email!, responseStatus: attendee.responseStatus || null })),
  };
}

function summarizeMessage(message: GmailMessage): EmailSummary {
  const headers = message.payload?.headers ?? [];
  const header = (name: string): string =>
    headers.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value?.slice(0, 1_000) || "";
  const dateHeader = header("Date");
  const internalDate = message.internalDate ? new Date(Number(message.internalDate)) : undefined;
  const internal = internalDate && !Number.isNaN(internalDate.getTime()) ? internalDate.toISOString() : "";
  return {
    id: message.id || "",
    threadId: message.threadId || "",
    from: header("From"),
    to: header("To"),
    subject: header("Subject") || "（无主题）",
    date: dateHeader || internal,
    snippet: message.snippet?.slice(0, 1_000) || "",
  };
}

function loadClientCredentials(path: string): { clientId: string; clientSecret?: string } {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("无法读取 Google OAuth 客户端 JSON。");
  }
  const root = value as Record<string, unknown>;
  const source = (root.installed || root.web) as Record<string, unknown> | undefined;
  if (!source || typeof source.client_id !== "string") {
    throw new Error("Google OAuth JSON 缺少 installed.client_id 或 web.client_id。");
  }
  return {
    clientId: source.client_id,
    ...(typeof source.client_secret === "string" ? { clientSecret: source.client_secret } : {}),
  };
}

async function startCallbackServer(expectedState: string): Promise<{
  redirectUri: string;
  waitForCode: () => Promise<string>;
  close: () => Promise<void>;
}> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  let settled = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/oauth/callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (state !== expectedState || !code || error) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("授权失败，可以关闭此页面。");
      if (!settled) rejectCode(new Error("Google OAuth 回调校验失败。"));
    } else {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("授权成功，可以关闭此页面并返回终端。");
      if (!settled) resolveCode(code);
    }
    settled = true;
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法启动 OAuth 回调端口。");
  const timer = setTimeout(() => {
    if (!settled) rejectCode(new Error("Google OAuth 授权等待超时。"));
    settled = true;
  }, 5 * 60_000);
  timer.unref();
  return {
    redirectUri: `http://127.0.0.1:${address.port}/oauth/callback`,
    waitForCode: () => codePromise,
    close: async () => {
      clearTimeout(timer);
      await closeServer(server);
    },
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function openBrowser(url: string): void {
  try {
    const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // The URL is printed for manual opening.
  }
}

function safeGoogleError(error: unknown): string {
  const googleError = error as {
    config?: { url?: unknown };
    response?: { status?: number; data?: { error?: { status?: string } } };
  };
  const response = googleError?.response;
  if (response?.status === 401 || response?.status === 403) {
    return "Google 授权已失效或权限不足，请重新运行 person-agent setup。";
  }
  if (
    response?.status === 400 &&
    response.data?.error?.status === "FAILED_PRECONDITION" &&
    String(googleError.config?.url ?? "").includes("gmail.googleapis.com")
  ) {
    return "当前 Google 账号未开通 Gmail；请先启用 Gmail，或改用 Gmail 账号重新授权。";
  }
  if (error instanceof Error && /refresh token|OAuth|Google OAuth|客户端 JSON/.test(error.message)) return error.message;
  return "Google 服务暂时不可用，请稍后重试。";
}
