import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { createAssistant, promptForText } from "../agent.js";
import { defaultApprovalExecutor, WorkflowActionError, type ApprovalExecutor } from "../calendar-actions.js";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../database.js";
import { TaskTransitionError } from "../domain/tasks.js";
import { generateKnowledgeDigest } from "../knowledge/digest.js";
import { syncZotero } from "../knowledge/zotero.js";
import type { Logger } from "../logger.js";
import type { AppPaths } from "../paths.js";
import type {
  AgentService,
  KnowledgeService,
  RouteRequest,
  RuntimeConfig,
  ServerServices,
} from "./context.js";
import { ApiError, MethodNotAllowedError, safeErrorMessage } from "./errors.js";
import type { HealthProbes } from "./health.js";
import { findRoute } from "./router.js";
import { routes } from "./routes/index.js";
import { defaultCalendarSource, type CalendarSource } from "./sources.js";
import type { TodayDependencies } from "./today.js";
import { PROTOCOL_VERSION, type ErrorPayload } from "./types.js";

const MAX_REQUEST_BYTES = 1_000_000;

export type LocalServerOptions = {
  token: string;
  paths: AppPaths;
  config: AppConfig;
  database: AppDatabase;
  logger?: Logger;
  now?: () => Date;
  calendar?: CalendarSource;
  weather?: TodayDependencies["weather"];
  probes?: HealthProbes;
  approvalExecutor?: ApprovalExecutor;
  knowledge?: KnowledgeService;
  agent?: AgentService;
};

export type LocalServer = {
  port: number;
  protocolVersion: string;
  close(): Promise<void>;
};

type RequestContext = {
  token: string;
  port: number;
  paths: AppPaths;
  database: AppDatabase;
  logger?: Logger;
  now: () => Date;
  runtime: RuntimeConfig;
  services: ServerServices;
  startedAt: number;
};

/** Starts the loopback-only UI service. Port 0 asks the operating system for a free port. */
export async function startLocalServer(
  options: LocalServerOptions & { port?: number },
): Promise<LocalServer> {
  const token = options.token.trim();
  if (!token) throw new Error("本地服务需要会话 token。");

  let port = 0;
  const startedAt = Date.now();
  const context: RequestContext = {
    token,
    port,
    paths: options.paths,
    database: options.database,
    now: options.now ?? (() => new Date()),
    runtime: { config: options.config },
    services: {
      calendar: options.calendar ?? defaultCalendarSource(options.paths),
      approvalExecutor: options.approvalExecutor ?? defaultApprovalExecutor(options.paths),
      knowledge: options.knowledge ?? defaultKnowledgeService,
      agent: options.agent ?? defaultAgentService,
      ...(options.weather ? { weather: options.weather } : {}),
      ...(options.probes ? { probes: options.probes } : {}),
    },
    startedAt,
    ...(options.logger ? { logger: options.logger } : {}),
  };

  const server = createServer((request, response) => {
    void handleRequest(request, response, context).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end();
      } else {
        response.end();
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(options.port ?? 0, "127.0.0.1");
    });
  } catch (error) {
    server.close();
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("无法确定本地服务端口。");
  }
  port = address.port;
  context.port = port;

  return {
    port,
    protocolVersion: PROTOCOL_VERSION,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
): Promise<void> {
  const requestId = randomUUID();
  const started = Date.now();
  const method = request.method ?? "GET";
  const path = safePath(request.url);
  let status = 500;

  try {
    validateRequest(request, context);
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${context.port}`);
    const lookup = findRoute(routes, method, url.pathname);
    if (!lookup) throw new ApiError(404, "NOT_FOUND", "接口不存在。");
    if ("allowed" in lookup) throw new MethodNotAllowedError(lookup.allowed);

    const body = await readBody(request);
    const routeRequest: RouteRequest = {
      method,
      path: url.pathname,
      params: lookup.params,
      query: url.searchParams,
      body,
      requestId,
      now: context.now(),
      startedAt: context.startedAt,
      paths: context.paths,
      runtime: context.runtime,
      database: context.database,
      services: context.services,
      ...(context.logger ? { logger: context.logger } : {}),
    };
    const result = await lookup.route.handler(routeRequest);
    status = result.status ?? 200;
    const generatedAt = new Date().toISOString();
    sendJson(response, status, injectMeta(result.body, requestId, generatedAt), requestId);
  } catch (error) {
    const apiError = toApiError(error);
    status = apiError.status;
    if (!(error instanceof ApiError) && !(error instanceof TaskTransitionError) && !(error instanceof WorkflowActionError)) {
      context.logger?.("http_error", {
        requestId,
        code: apiError.code,
        error: safeErrorMessage(error),
      });
    }
    if (response.headersSent) {
      response.end();
      return;
    }
    const payload: ErrorPayload = {
      requestId,
      error: {
        code: apiError.code,
        message: apiError.message,
        retryable: apiError.retryable,
        ...(apiError.fieldErrors ? { fieldErrors: apiError.fieldErrors } : {}),
      },
    };
    sendJson(
      response,
      apiError.status,
      payload,
      requestId,
      apiError instanceof MethodNotAllowedError ? apiError.allowed.join(", ") : undefined,
    );
  } finally {
    context.logger?.("http_request", {
      requestId,
      method,
      path,
      status,
      durationMs: Date.now() - started,
    });
  }
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof TaskTransitionError) {
    return new ApiError(
      error.message.startsWith("找不到") ? 404 : 409,
      error.message.startsWith("找不到") ? "NOT_FOUND" : "CONFLICT",
      error.message,
    );
  }
  if (error instanceof WorkflowActionError) {
    return new ApiError(
      error.status,
      error.status === 404 ? "NOT_FOUND" : "CONFLICT",
      error.message,
    );
  }
  return new ApiError(500, "INTERNAL_ERROR", "本地服务发生错误。", false);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const method = request.method ?? "GET";
  if (method !== "POST" && method !== "PATCH" && method !== "PUT") return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "请求内容过大。", false);
    }
    chunks.push(buffer);
  }
  if (!total) return undefined;
  const contentType = request.headers["content-type"] ?? "";
  if (!/^application\/json\b/i.test(contentType)) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "写请求必须使用 application/json。", false);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "请求体不是有效的 JSON。", false);
  }
}

function injectMeta(body: unknown, requestId: string, generatedAt: string): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (!("requestId" in record)) record.requestId = requestId;
  if (!("generatedAt" in record)) record.generatedAt = generatedAt;
  return record;
}

function validateRequest(request: IncomingMessage, context: RequestContext): void {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "请求内容过大。", false);
  }
  const host = request.headers.host?.toLowerCase();
  const allowedHosts = new Set([
    `127.0.0.1:${context.port}`,
    `localhost:${context.port}`,
  ]);
  if (!host || !allowedHosts.has(host)) {
    throw new ApiError(400, "BAD_HOST", "请求来源无效。", false);
  }
  if (request.headers.origin !== undefined) {
    throw new ApiError(403, "FORBIDDEN", "不接受浏览器来源请求。", false);
  }
  const provided = request.headers["x-person-agent-token"];
  if (typeof provided !== "string" || !tokensMatch(provided, context.token)) {
    throw new ApiError(401, "UNAUTHORIZED", "会话令牌无效或缺失。", false);
  }
}

function tokensMatch(provided: string, expected: string): boolean {
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  requestId: string,
  allow?: string,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": requestId,
    ...(allow ? { Allow: allow } : {}),
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function safePath(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

const defaultKnowledgeService: KnowledgeService = {
  async sync(request) {
    return await syncZotero({
      config: request.runtime.config,
      database: request.database,
      ...(request.logger ? { logger: request.logger } : {}),
    });
  },
  async digest(request, onStage) {
    return await generateKnowledgeDigest(
      {
        paths: request.paths,
        config: request.runtime.config,
        database: request.database,
        ...(request.logger ? { logger: request.logger } : {}),
      },
      {
        now: new Date(),
        openNote: false,
        ...(onStage ? { onStage } : {}),
      },
    );
  },
};

async function defaultAgentService(request: RouteRequest, message: string): Promise<string> {
  const agent = await createAssistant({
    paths: request.paths,
    config: request.runtime.config,
    database: request.database,
  });
  return await promptForText(agent, message);
}
