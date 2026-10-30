using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using PersonAgent.Desktop.Models;

namespace PersonAgent.Desktop.Services;

public sealed class LocalApiException : Exception
{
    public LocalApiException(int statusCode, string code, string message, bool retryable)
        : base(message)
    {
        StatusCode = statusCode;
        Code = code;
        Retryable = retryable;
    }

    public int StatusCode { get; }
    public string Code { get; }
    public bool Retryable { get; }
}

public sealed class LocalApiClient : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly HttpClient _http;

    public LocalApiClient(int port, string token)
    {
        _http = new HttpClient
        {
            BaseAddress = new Uri($"http://127.0.0.1:{port}/"),
            Timeout = Timeout.InfiniteTimeSpan,
        };
        _http.DefaultRequestHeaders.Add("X-Person-Agent-Token", token);
    }

    public Task<HealthResponse> GetHealthAsync(CancellationToken cancellationToken = default) =>
        GetAsync<HealthResponse>("api/health", cancellationToken);

    public Task<TodayResponse> GetTodayAsync(string? date = null, CancellationToken cancellationToken = default)
    {
        var path = string.IsNullOrWhiteSpace(date)
            ? "api/today"
            : $"api/today?date={Uri.EscapeDataString(date)}";
        return GetAsync<TodayResponse>(path, cancellationToken);
    }

    public Task<TaskListResponse> GetTasksAsync(string? status = null, CancellationToken cancellationToken = default)
    {
        var path = string.IsNullOrWhiteSpace(status)
            ? "api/tasks"
            : $"api/tasks?status={Uri.EscapeDataString(status)}";
        return GetAsync<TaskListResponse>(path, cancellationToken);
    }

    public Task<TaskResponse> CreateTaskAsync(
        string title,
        string taskKind,
        int estimatedMinutes,
        string? deadline,
        string priority,
        CancellationToken cancellationToken = default) =>
        SendAsync<TaskResponse>(
            HttpMethod.Post,
            "api/tasks",
            new { Title = title, TaskKind = taskKind, EstimatedMinutes = estimatedMinutes, Deadline = deadline, Priority = priority },
            TimeSpan.FromSeconds(20),
            cancellationToken);

    public Task<TaskResponse> EditTaskAsync(
        string taskId,
        string? title,
        string? taskKind,
        int? estimatedMinutes,
        string? deadline,
        bool clearDeadline,
        string? priority,
        CancellationToken cancellationToken = default)
    {
        var body = new Dictionary<string, object?> { ["operation"] = "edit" };
        if (title is not null) body["title"] = title;
        if (taskKind is not null) body["taskKind"] = taskKind;
        if (estimatedMinutes is not null) body["estimatedMinutes"] = estimatedMinutes;
        if (deadline is not null) body["deadline"] = deadline;
        else if (clearDeadline) body["deadline"] = null;
        if (priority is not null) body["priority"] = priority;
        return SendAsync<TaskResponse>(
            HttpMethod.Patch,
            $"api/tasks/{Uri.EscapeDataString(taskId)}",
            body,
            TimeSpan.FromSeconds(20),
            cancellationToken);
    }

    public Task<TaskResponse> TaskCommandAsync(string taskId, string operation, CancellationToken cancellationToken = default) =>
        SendAsync<TaskResponse>(
            HttpMethod.Patch,
            $"api/tasks/{Uri.EscapeDataString(taskId)}",
            new { Operation = operation },
            TimeSpan.FromSeconds(20),
            cancellationToken);

    public Task<CandidateSlotsResponse> GetCandidateSlotsAsync(
        string taskId,
        string start,
        string end,
        int limit = 5,
        CancellationToken cancellationToken = default) =>
        GetAsync<CandidateSlotsResponse>(
            $"api/tasks/{Uri.EscapeDataString(taskId)}/candidate-slots?start={Uri.EscapeDataString(start)}&end={Uri.EscapeDataString(end)}&limit={limit}",
            cancellationToken);

    public Task<ApprovalResponse> ScheduleTaskAsync(
        string taskId,
        string startAt,
        string endAt,
        CancellationToken cancellationToken = default) =>
        SendAsync<ApprovalResponse>(
            HttpMethod.Post,
            $"api/tasks/{Uri.EscapeDataString(taskId)}/schedule",
            new { StartAt = startAt, EndAt = endAt },
            TimeSpan.FromSeconds(20),
            cancellationToken);

    public Task<CalendarResponse> GetCalendarAsync(
        string start,
        string end,
        CancellationToken cancellationToken = default) =>
        GetAsync<CalendarResponse>(
            $"api/calendar?start={Uri.EscapeDataString(start)}&end={Uri.EscapeDataString(end)}",
            cancellationToken);

    public Task<LectureListResponse> GetLecturesAsync(
        string? start = null,
        string? end = null,
        CancellationToken cancellationToken = default)
    {
        var query = new List<string>();
        if (!string.IsNullOrWhiteSpace(start)) query.Add($"start={Uri.EscapeDataString(start)}");
        if (!string.IsNullOrWhiteSpace(end)) query.Add($"end={Uri.EscapeDataString(end)}");
        var path = query.Count == 0 ? "api/lectures" : $"api/lectures?{string.Join("&", query)}";
        return GetAsync<LectureListResponse>(path, cancellationToken);
    }

    public Task<LectureResponse> CreateLectureAsync(
        string title,
        string startAt,
        string? endAt,
        string? location,
        string? speaker,
        string? notes,
        bool requiresPresentation,
        CancellationToken cancellationToken = default) =>
        SendAsync<LectureResponse>(
            HttpMethod.Post,
            "api/lectures",
            new
            {
                Title = title,
                StartAt = startAt,
                EndAt = endAt,
                Location = location,
                Speaker = speaker,
                Notes = notes,
                RequiresPresentation = requiresPresentation,
            },
            TimeSpan.FromSeconds(20),
            cancellationToken);

    public Task<IdeaResponse> CreateIdeaAsync(
        string body,
        string? title,
        IReadOnlyList<string> tags,
        CancellationToken cancellationToken = default) =>
        SendAsync<IdeaResponse>(
            HttpMethod.Post,
            "api/ideas",
            new { Body = body, Title = title, Tags = tags },
            TimeSpan.FromSeconds(20),
            cancellationToken);

    public Task<PaperListResponse> GetPapersAsync(
        string? state = null,
        string sort = "recent",
        int offset = 0,
        int limit = 100,
        CancellationToken cancellationToken = default)
    {
        var query = new List<string> { $"sort={Uri.EscapeDataString(sort)}", $"offset={offset}", $"limit={limit}" };
        if (!string.IsNullOrWhiteSpace(state)) query.Add($"state={Uri.EscapeDataString(state)}");
        return GetAsync<PaperListResponse>($"api/papers?{string.Join("&", query)}", cancellationToken);
    }

    public Task<PaperResponse> GetPaperAsync(string key, CancellationToken cancellationToken = default) =>
        GetAsync<PaperResponse>($"api/papers/{Uri.EscapeDataString(key)}", cancellationToken);

    public Task<OperationResponse> StartKnowledgeSyncAsync(CancellationToken cancellationToken = default) =>
        SendAsync<OperationResponse>(HttpMethod.Post, "api/knowledge/sync", null, TimeSpan.FromSeconds(20), cancellationToken);

    public Task<OperationResponse> StartKnowledgeDigestAsync(CancellationToken cancellationToken = default) =>
        SendAsync<OperationResponse>(HttpMethod.Post, "api/knowledge/digest", null, TimeSpan.FromSeconds(20), cancellationToken);

    public Task<OperationResponse> GetOperationAsync(string id, CancellationToken cancellationToken = default) =>
        GetAsync<OperationResponse>($"api/operations/{Uri.EscapeDataString(id)}", cancellationToken);

    public Task<ApprovalListResponse> GetApprovalsAsync(string? status = null, CancellationToken cancellationToken = default)
    {
        var path = string.IsNullOrWhiteSpace(status)
            ? "api/approvals"
            : $"api/approvals?status={Uri.EscapeDataString(status)}";
        return GetAsync<ApprovalListResponse>(path, cancellationToken);
    }

    public Task<ApprovalResponse> ApproveAsync(string id, CancellationToken cancellationToken = default) =>
        SendAsync<ApprovalResponse>(HttpMethod.Post, $"api/approvals/{Uri.EscapeDataString(id)}/approve", null, TimeSpan.FromSeconds(30), cancellationToken);

    public Task<ApprovalResponse> RejectAsync(string id, CancellationToken cancellationToken = default) =>
        SendAsync<ApprovalResponse>(HttpMethod.Post, $"api/approvals/{Uri.EscapeDataString(id)}/reject", null, TimeSpan.FromSeconds(20), cancellationToken);

    public Task<SettingsResponse> GetSettingsAsync(CancellationToken cancellationToken = default) =>
        GetAsync<SettingsResponse>("api/settings", cancellationToken);

    public Task<SettingsResponse> UpdateSettingsAsync(object body, CancellationToken cancellationToken = default) =>
        SendAsync<SettingsResponse>(HttpMethod.Patch, "api/settings", body, TimeSpan.FromSeconds(30), cancellationToken);

    public Task<SearchResponse> SearchAsync(string query, string? types = null, int limit = 30, CancellationToken cancellationToken = default)
    {
        var path = $"api/search?q={Uri.EscapeDataString(query)}&limit={limit}";
        if (!string.IsNullOrWhiteSpace(types)) path += $"&types={Uri.EscapeDataString(types)}";
        return GetAsync<SearchResponse>(path, cancellationToken);
    }

    public Task<AgentMessageResponse> SendAgentMessageAsync(string message, CancellationToken cancellationToken = default) =>
        SendAsync<AgentMessageResponse>(
            HttpMethod.Post,
            "api/agent/messages",
            new { Message = message },
            TimeSpan.FromSeconds(180),
            cancellationToken);

    private Task<T> GetAsync<T>(string path, CancellationToken cancellationToken) =>
        SendCoreAsync<T>(HttpMethod.Get, path, null, TimeSpan.FromSeconds(20), cancellationToken);

    private Task<T> SendAsync<T>(
        HttpMethod method,
        string path,
        object? body,
        TimeSpan timeout,
        CancellationToken cancellationToken) =>
        SendCoreAsync<T>(method, path, body, timeout, cancellationToken);

    private async Task<T> SendCoreAsync<T>(
        HttpMethod method,
        string path,
        object? body,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);
        using var request = new HttpRequestMessage(method, path);
        if (body is not null)
        {
            request.Content = new StringContent(
                JsonSerializer.Serialize(body, JsonOptions),
                Encoding.UTF8,
                "application/json");
        }
        HttpResponseMessage response;
        try
        {
            response = await _http.SendAsync(request, HttpCompletionOption.ResponseContentRead, timeoutSource.Token)
                .ConfigureAwait(false);
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new LocalApiException(408, "TIMEOUT", "本地服务响应超时，请重试。", true);
        }
        using (response)
        {
            var content = await response.Content.ReadAsStringAsync(timeoutSource.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                ErrorResponse? error = null;
                try
                {
                    error = JsonSerializer.Deserialize<ErrorResponse>(content, JsonOptions);
                }
                catch (JsonException)
                {
                    // The status code still carries enough information for the UI.
                }
                throw new LocalApiException(
                    (int)response.StatusCode,
                    error?.Error.Code ?? "HTTP_ERROR",
                    error?.Error.Message ?? $"本地服务返回 HTTP {(int)response.StatusCode}。",
                    error?.Error.Retryable ?? ((int)response.StatusCode >= 500));
            }
            var value = JsonSerializer.Deserialize<T>(content, JsonOptions);
            return value ?? throw new LocalApiException(500, "INVALID_RESPONSE", "本地服务返回了空响应。", true);
        }
    }

    public void Dispose() => _http.Dispose();
}
