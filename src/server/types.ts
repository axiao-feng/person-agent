export const PROTOCOL_VERSION = "1";

export type SourceState = "available" | "unavailable" | "not_configured" | "unknown";

export type SourceStatus = {
  state: SourceState;
  updatedAt: string | null;
  message: string | null;
};

export type ResponseMeta = {
  requestId: string;
  generatedAt: string;
};

export type ServiceInfo = {
  version: string;
  protocolVersion: string;
  uptimeSeconds: number;
};

export type WorkerState = "running" | "stopped" | "not_installed" | "unknown";

export type WorkerInfo = {
  state: WorkerState;
  lastRunAt: string | null;
};

export type HealthConnections = {
  database: SourceStatus;
  vault: SourceStatus;
  zotero: SourceStatus;
  googleCalendar: SourceStatus;
  gmail: SourceStatus;
  deepSeek: SourceStatus;
  weather: SourceStatus;
};

export type HealthResponse = ResponseMeta & {
  status: "ok" | "degraded";
  service: ServiceInfo;
  worker: WorkerInfo;
  connections: HealthConnections;
};

export type ErrorPayload = {
  requestId: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    fieldErrors?: Record<string, string>;
  };
};

export type WeatherSummary = {
  city: string;
  condition: string;
  temperature: number | null;
  apparentTemperature: number | null;
  precipitationProbability: number | null;
  windSpeed: number | null;
};

export type FocusReasonCode =
  | "in_progress"
  | "planned_today"
  | "due_today"
  | "overdue"
  | "high_priority"
  | "presentation_today";

export type FocusItem = {
  type: "task" | "lecture";
  id: string;
  title: string;
  reasonCode: FocusReasonCode;
  startAt: string | null;
  endAt: string | null;
  deadline: string | null;
};

export type TimelineSource = "google" | "lecture" | "task" | "automation" | "approval";

export type TimelineItem = {
  id: string;
  source: TimelineSource;
  title: string;
  startAt: string;
  endAt: string | null;
  allDay: boolean;
  status: string;
  detail: string | null;
  linkedObjectId: string | null;
};

export type PaperEvidenceState =
  | "pending"
  | "retrying"
  | "abstract_only"
  | "fulltext"
  | "truncated_fulltext";

export type PaperSummary = {
  key: string;
  title: string;
  creators: string[];
  dateText: string | null;
  tags: string[];
  evidenceState: PaperEvidenceState;
  retryAt: string | null;
  firstSeenAt: string;
  updatedAt: string;
};

export type ApprovalDisplay = {
  target: "Google Calendar";
  title: string;
  reason: string | null;
  originalStart: string | null;
  originalEnd: string | null;
  proposedStart: string;
  proposedEnd: string;
};

export type Approval = {
  id: string;
  kind: "calendar.create" | "calendar.update";
  status: "pending" | "approved" | "executing" | "executed" | "failed" | "rejected";
  display: ApprovalDisplay;
  error: string | null;
  createdAt: string;
  approvedAt: string | null;
  executedAt: string | null;
};

export type TodayResponse = ResponseMeta & {
  date: string;
  timezone: string;
  status: "success" | "partial";
  sources: Record<string, SourceStatus>;
  weather: WeatherSummary | null;
  focusItems: FocusItem[];
  timeline: TimelineItem[];
  knowledgeItems: PaperSummary[];
  approvals: Approval[];
};

export type CalendarItem = {
  id: string;
  source: "google" | "lecture" | "task" | "approval";
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  status: string;
  conflict: boolean;
  linkedObjectId: string | null;
};

export type CalendarResponse = ResponseMeta & {
  status: "success" | "partial";
  sources: Record<string, SourceStatus>;
  items: CalendarItem[];
};

export type OperationDto = {
  id: string;
  kind: "knowledge.sync" | "knowledge.digest";
  status: "queued" | "running" | "succeeded" | "failed";
  stage: string | null;
  progressCurrent: number | null;
  progressTotal: number | null;
  result: unknown;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type AutomationSetting = {
  enabled: boolean;
  time: string;
  lastRunAt: string | null;
  lastResult: "delivered" | "failed" | "skipped" | null;
  nextRunAt: string | null;
};

export type Settings = {
  timezone: string;
  knowledgeVaultPath: string;
  location: {
    city: string;
    latitude: number;
    longitude: number;
    timezone: string;
  } | null;
  automations: {
    briefing: AutomationSetting;
    knowledgeDigest: AutomationSetting;
  };
  connections: Record<string, SourceStatus>;
};

export type SearchResult = {
  type: "paper" | "task" | "idea" | "lecture";
  id: string;
  title: string;
  source: string;
  snippet: string | null;
  openTarget: string | null;
};

export type IdeaDto = {
  title: string;
  relativePath: string;
  createdAt: string;
  tags: string[];
  openUrl: string | null;
};

export type ConversationStatus = "active" | "archived";

export type ConversationDto = {
  id: string;
  title: string | null;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  messageCount: number;
};

export type TranscriptMessageDto = {
  id: string;
  sequence: number;
  role: "user" | "assistant" | "toolResult" | "system";
  text: string;
  createdAt: string;
};

export type AgentReferenceDto = {
  type: "paper" | "task" | "idea" | "lecture" | "approval";
  id: string;
  title: string;
};

export type ConversationListResponse = ResponseMeta & {
  items: ConversationDto[];
};

export type ConversationResponse = ResponseMeta & {
  conversation: ConversationDto;
};

export type ConversationTranscriptResponse = ResponseMeta & {
  conversation: ConversationDto;
  messages: TranscriptMessageDto[];
};

export type AgentMessageResponse = ResponseMeta & {
  conversationId: string;
  answer: string;
  references: AgentReferenceDto[];
  conversation: ConversationDto;
};
