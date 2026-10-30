namespace PersonAgent.Desktop.Models;

public sealed class HealthResponse
{
    public string RequestId { get; set; } = "";
    public string GeneratedAt { get; set; } = "";
    public string Status { get; set; } = "";
    public ServiceInfo Service { get; set; } = new();
    public WorkerInfo Worker { get; set; } = new();
    public Dictionary<string, SourceStatus> Connections { get; set; } = new();
}

public sealed class ServiceInfo
{
    public string Version { get; set; } = "";
    public string ProtocolVersion { get; set; } = "";
    public long UptimeSeconds { get; set; }
}

public sealed class WorkerInfo
{
    public string State { get; set; } = "unknown";
    public string? LastRunAt { get; set; }
}

public sealed class SourceStatus
{
    public string State { get; set; } = "unknown";
    public string? UpdatedAt { get; set; }
    public string? Message { get; set; }
}

public sealed class TodayResponse
{
    public string RequestId { get; set; } = "";
    public string GeneratedAt { get; set; } = "";
    public string Date { get; set; } = "";
    public string Timezone { get; set; } = "";
    public string Status { get; set; } = "";
    public Dictionary<string, SourceStatus> Sources { get; set; } = new();
    public WeatherSummary? Weather { get; set; }
    public List<FocusItem> FocusItems { get; set; } = new();
    public List<TimelineItem> Timeline { get; set; } = new();
    public List<PaperSummary> KnowledgeItems { get; set; } = new();
    public List<Approval> Approvals { get; set; } = new();
}

public sealed class WeatherSummary
{
    public string City { get; set; } = "";
    public string Condition { get; set; } = "";
    public double? Temperature { get; set; }
    public double? ApparentTemperature { get; set; }
    public double? PrecipitationProbability { get; set; }
    public double? WindSpeed { get; set; }
}

public sealed class FocusItem
{
    public string Type { get; set; } = "";
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string ReasonCode { get; set; } = "";
    public string? StartAt { get; set; }
    public string? EndAt { get; set; }
    public string? Deadline { get; set; }
}

public sealed class TimelineItem
{
    public string Id { get; set; } = "";
    public string Source { get; set; } = "";
    public string Title { get; set; } = "";
    public string StartAt { get; set; } = "";
    public string? EndAt { get; set; }
    public bool AllDay { get; set; }
    public string Status { get; set; } = "";
    public string? Detail { get; set; }
    public string? LinkedObjectId { get; set; }
}

public class PaperSummary
{
    public string Key { get; set; } = "";
    public string Title { get; set; } = "";
    public List<string> Creators { get; set; } = new();
    public string? DateText { get; set; }
    public List<string> Tags { get; set; } = new();
    public string EvidenceState { get; set; } = "";
    public string? RetryAt { get; set; }
    public string FirstSeenAt { get; set; } = "";
    public string UpdatedAt { get; set; } = "";
}

public sealed class Approval
{
    public string Id { get; set; } = "";
    public string Kind { get; set; } = "";
    public string Status { get; set; } = "";
    public ApprovalDisplay Display { get; set; } = new();
    public string? Error { get; set; }
    public string CreatedAt { get; set; } = "";
    public string? ApprovedAt { get; set; }
    public string? ExecutedAt { get; set; }
}

public sealed class ApprovalDisplay
{
    public string Target { get; set; } = "";
    public string Title { get; set; } = "";
    public string? Reason { get; set; }
    public string? OriginalStart { get; set; }
    public string? OriginalEnd { get; set; }
    public string ProposedStart { get; set; } = "";
    public string ProposedEnd { get; set; } = "";
}

public sealed class ErrorResponse
{
    public string RequestId { get; set; } = "";
    public ErrorBody Error { get; set; } = new();
}

public sealed class ErrorBody
{
    public string Code { get; set; } = "";
    public string Message { get; set; } = "";
    public bool Retryable { get; set; }
    public Dictionary<string, string>? FieldErrors { get; set; }
}

public sealed class TaskItem
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string TaskKind { get; set; } = "research";
    public string SourceType { get; set; } = "manual";
    public string? SourceId { get; set; }
    public string? Deadline { get; set; }
    public int EstimatedMinutes { get; set; }
    public string Priority { get; set; } = "medium";
    public string Status { get; set; } = "draft";
    public double Confidence { get; set; }
    public string? PlannedStart { get; set; }
    public string? PlannedEnd { get; set; }
    public string? CalendarEventId { get; set; }
    public string CreatedAt { get; set; } = "";
    public string UpdatedAt { get; set; } = "";
}

public sealed class TaskListResponse
{
    public List<TaskItem> Items { get; set; } = new();
}

public sealed class TaskResponse
{
    public TaskItem Task { get; set; } = new();
}

public sealed class CandidateSlot
{
    public string StartAt { get; set; } = "";
    public string EndAt { get; set; } = "";
    public int AvailableMinutes { get; set; }
}

public sealed class CandidateSlotsResponse
{
    public string TaskId { get; set; } = "";
    public List<CandidateSlot> Slots { get; set; } = new();
}

public sealed class CalendarItem
{
    public string Id { get; set; } = "";
    public string Source { get; set; } = "";
    public string Title { get; set; } = "";
    public string StartAt { get; set; } = "";
    public string EndAt { get; set; } = "";
    public bool AllDay { get; set; }
    public string Status { get; set; } = "";
    public bool Conflict { get; set; }
    public string? LinkedObjectId { get; set; }
}

public sealed class CalendarResponse
{
    public string RequestId { get; set; } = "";
    public string GeneratedAt { get; set; } = "";
    public string Status { get; set; } = "";
    public Dictionary<string, SourceStatus> Sources { get; set; } = new();
    public List<CalendarItem> Items { get; set; } = new();
}

public sealed class Lecture
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string StartAt { get; set; } = "";
    public string? EndAt { get; set; }
    public string? Location { get; set; }
    public string? Speaker { get; set; }
    public string? Notes { get; set; }
    public bool RequiresPresentation { get; set; }
    public string Status { get; set; } = "active";
    public string CreatedAt { get; set; } = "";
    public string UpdatedAt { get; set; } = "";
}

public sealed class LectureListResponse
{
    public List<Lecture> Items { get; set; } = new();
}

public sealed class LectureResponse
{
    public Lecture Lecture { get; set; } = new();
}

public sealed class IdeaNote
{
    public string Title { get; set; } = "";
    public string RelativePath { get; set; } = "";
    public string CreatedAt { get; set; } = "";
    public List<string> Tags { get; set; } = new();
    public string? OpenUrl { get; set; }
}

public sealed class IdeaResponse
{
    public IdeaNote Idea { get; set; } = new();
}

public sealed class PaperAnalysis
{
    public string Direction { get; set; } = "";
    public string Results { get; set; } = "";
    public string Limitations { get; set; } = "";
    public string Basis { get; set; } = "";
    public bool Truncated { get; set; }
}

public sealed class PaperDetail : PaperSummary
{
    public string ItemType { get; set; } = "";
    public int Version { get; set; }
    public string? Abstract { get; set; }
    public string? Doi { get; set; }
    public string? SourceUrl { get; set; }
    public string FulltextState { get; set; } = "unknown";
    public string AnalysisState { get; set; } = "pending";
    public PaperAnalysis? Analysis { get; set; }
    public string? AnalysisError { get; set; }
    public string? AnalyzedAt { get; set; }
    public PaperLinks Links { get; set; } = new();
}

public sealed class PaperLinks
{
    public string? Zotero { get; set; }
    public string? Obsidian { get; set; }
}

public sealed class PaperListResponse
{
    public List<PaperSummary> Items { get; set; } = new();
    public int Offset { get; set; }
    public int Limit { get; set; }
    public int Total { get; set; }
    public PaperCounts Counts { get; set; } = new();
}

public sealed class PaperCounts
{
    public int Pending { get; set; }
    public int Retrying { get; set; }
    public int Partial { get; set; }
    public int Complete { get; set; }
}

public sealed class PaperResponse
{
    public PaperDetail Paper { get; set; } = new();
}

public sealed class Operation
{
    public string Id { get; set; } = "";
    public string Kind { get; set; } = "";
    public string Status { get; set; } = "";
    public string? Stage { get; set; }
    public int? ProgressCurrent { get; set; }
    public int? ProgressTotal { get; set; }
    public object? Result { get; set; }
    public string? Error { get; set; }
    public string CreatedAt { get; set; } = "";
    public string? StartedAt { get; set; }
    public string? CompletedAt { get; set; }
}

public sealed class OperationResponse
{
    public Operation Operation { get; set; } = new();
}

public sealed class ApprovalListResponse
{
    public List<Approval> Items { get; set; } = new();
}

public sealed class ApprovalResponse
{
    public Approval Approval { get; set; } = new();
}

public sealed class AutomationSetting
{
    public bool Enabled { get; set; }
    public string Time { get; set; } = "07:30";
    public string? LastRunAt { get; set; }
    public string? LastResult { get; set; }
    public string? NextRunAt { get; set; }
}

public sealed class Settings
{
    public string Timezone { get; set; } = "Asia/Shanghai";
    public string KnowledgeVaultPath { get; set; } = "";
    public LocationSettings? Location { get; set; }
    public AutomationSettings Automations { get; set; } = new();
    public Dictionary<string, SourceStatus> Connections { get; set; } = new();
}

public sealed class LocationSettings
{
    public string City { get; set; } = "";
    public double Latitude { get; set; }
    public double Longitude { get; set; }
    public string Timezone { get; set; } = "";
}

public sealed class AutomationSettings
{
    public AutomationSetting Briefing { get; set; } = new();
    public AutomationSetting KnowledgeDigest { get; set; } = new();
}

public sealed class SettingsResponse
{
    public Settings Settings { get; set; } = new();
}

public sealed class SearchResult
{
    public string Type { get; set; } = "";
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string Source { get; set; } = "";
    public string? Snippet { get; set; }
    public string? OpenTarget { get; set; }
}

public sealed class SearchResponse
{
    public string Query { get; set; } = "";
    public List<SearchResult> Items { get; set; } = new();
}

public sealed class AgentMessageResponse
{
    public string ConversationId { get; set; } = "";
    public string Answer { get; set; } = "";
    public List<AgentReference> References { get; set; } = new();
}

public sealed class AgentReference
{
    public string Type { get; set; } = "";
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
}

