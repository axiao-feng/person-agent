import type { AppConfig } from "../config.js";
import type { ApprovalExecutor } from "../calendar-actions.js";
import type { AppDatabase } from "../database.js";
import type { Logger } from "../logger.js";
import type { AppPaths } from "../paths.js";
import type { HealthProbes } from "./health.js";
import type { CalendarSource } from "./sources.js";
import type { TodayDependencies } from "./today.js";

export type RuntimeConfig = {
  config: AppConfig;
};

export type KnowledgeService = {
  sync(context: RouteRequest, onStage?: (stage: string) => void): Promise<unknown>;
  digest(context: RouteRequest, onStage?: (stage: string) => void): Promise<unknown>;
};

export type AgentService = (context: RouteRequest, message: string) => Promise<string>;

export type ServerServices = {
  calendar: CalendarSource;
  weather?: TodayDependencies["weather"];
  probes?: HealthProbes;
  approvalExecutor: ApprovalExecutor;
  knowledge: KnowledgeService;
  agent: AgentService;
};

export type RouteRequest = {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  requestId: string;
  now: Date;
  startedAt: number;
  paths: AppPaths;
  runtime: RuntimeConfig;
  database: AppDatabase;
  logger?: Logger;
  services: ServerServices;
};

export type RouteResult = {
  status?: number;
  body: unknown;
};

export type RouteHandler = (request: RouteRequest) => Promise<RouteResult>;

export type Route = {
  method: string;
  pattern: string;
  handler: RouteHandler;
};
