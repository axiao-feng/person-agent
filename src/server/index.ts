export { collectHealth, type HealthProbes } from "./health.js";
export { startLocalServer, type LocalServer, type LocalServerOptions } from "./local-server.js";
export { defaultCalendarSource, probeZotero, type CalendarSource } from "./sources.js";
export { buildTodaySnapshot, type TodayDependencies } from "./today.js";
export { PROTOCOL_VERSION } from "./types.js";
export type {
  Approval,
  ApprovalDisplay,
  ErrorPayload,
  FocusItem,
  FocusReasonCode,
  HealthConnections,
  HealthResponse,
  PaperEvidenceState,
  PaperSummary,
  ResponseMeta,
  ServiceInfo,
  SourceState,
  SourceStatus,
  TimelineItem,
  TimelineSource,
  TodayResponse,
  WeatherSummary,
  WorkerInfo,
  WorkerState,
} from "./types.js";
