using System.Collections.ObjectModel;
using System.Net.Http;
using System.Windows;
using System.Windows.Input;
using PersonAgent.Desktop.Models;
using PersonAgent.Desktop.Services;

namespace PersonAgent.Desktop.ViewModels;

public sealed class TodayViewModel : ObservableObject, IWorkspacePage
{
    private readonly Func<LocalApiClient?> _clientProvider;
    private readonly Func<Task> _retryService;
    private readonly Action _openDiagnostics;
    private bool _isLoading;
    private bool _isRefreshing;
    private bool _hasData;
    private bool _hasError;
    private string _errorMessage = "";
    private bool _isPartial;
    private string _partialMessage = "";
    private string _calendarHint = "";
    private string _dateText = "";
    private string _greetingText = "";
    private string _weatherText = "天气暂不可用";
    private string _updatedText = "尚未更新";
    private DetailViewModel? _selectedDetail;
    private string _timezone = "Asia/Shanghai";
    private bool _isApprovalBusy;
    private string _actionMessage = "";
    private bool _isActionError;

    public TodayViewModel(
        Func<LocalApiClient?> clientProvider,
        Func<Task> retryService,
        Action openDiagnostics)
    {
        _clientProvider = clientProvider;
        _retryService = retryService;
        _openDiagnostics = openDiagnostics;
        RefreshCommand = new AsyncRelayCommand(() => LoadAsync(refresh: true));
        RetryCommand = new AsyncRelayCommand(async () =>
        {
            if (_clientProvider() is null)
            {
                await _retryService();
            }
            else
            {
                await LoadAsync(refresh: true);
            }
        });
        DiagnosticsCommand = new RelayCommand(_openDiagnostics);
        SelectItemCommand = new RelayCommand(SelectItem);
        CloseDetailCommand = new RelayCommand(() => SelectedDetail = null);
        OpenApprovalsCommand = new RelayCommand(OpenFirstApproval);
        ApproveSelectedCommand = new AsyncRelayCommand(ApproveSelectedAsync);
        RejectSelectedCommand = new AsyncRelayCommand(RejectSelectedAsync);
        ApplyLocalDateFallback();
    }

    public ObservableCollection<FocusItemViewModel> FocusItems { get; } = new();
    public ObservableCollection<TimelineItemViewModel> TimelineItems { get; } = new();
    public ObservableCollection<KnowledgeItemViewModel> KnowledgeItems { get; } = new();
    public ObservableCollection<ApprovalViewModel> Approvals { get; } = new();

    public ICommand RefreshCommand { get; }
    public ICommand RetryCommand { get; }
    public ICommand DiagnosticsCommand { get; }
    public ICommand SelectItemCommand { get; }
    public ICommand CloseDetailCommand { get; }
    public ICommand OpenApprovalsCommand { get; }
    public ICommand ApproveSelectedCommand { get; }
    public ICommand RejectSelectedCommand { get; }

    public string Timezone => _timezone;

    public bool IsApprovalBusy
    {
        get => _isApprovalBusy;
        private set => SetProperty(ref _isApprovalBusy, value);
    }

    public string ActionMessage
    {
        get => _actionMessage;
        private set
        {
            if (SetProperty(ref _actionMessage, value)) OnPropertyChanged(nameof(HasActionMessage));
        }
    }

    public bool HasActionMessage => !string.IsNullOrWhiteSpace(ActionMessage);

    public bool IsActionError
    {
        get => _isActionError;
        private set => SetProperty(ref _isActionError, value);
    }

    public bool IsLoading
    {
        get => _isLoading;
        private set
        {
            if (SetProperty(ref _isLoading, value)) OnPropertyChanged(nameof(ShowInitialLoading));
        }
    }

    public bool IsRefreshing
    {
        get => _isRefreshing;
        private set => SetProperty(ref _isRefreshing, value);
    }

    public bool HasData
    {
        get => _hasData;
        private set
        {
            if (SetProperty(ref _hasData, value)) OnPropertyChanged(nameof(ShowInitialLoading));
        }
    }

    public bool ShowInitialLoading => IsLoading && !HasData;

    public bool HasError
    {
        get => _hasError;
        private set => SetProperty(ref _hasError, value);
    }

    public string ErrorMessage
    {
        get => _errorMessage;
        private set => SetProperty(ref _errorMessage, value);
    }

    public bool IsPartial
    {
        get => _isPartial;
        private set => SetProperty(ref _isPartial, value);
    }

    public string PartialMessage
    {
        get => _partialMessage;
        private set => SetProperty(ref _partialMessage, value);
    }

    public string CalendarHint
    {
        get => _calendarHint;
        private set
        {
            if (SetProperty(ref _calendarHint, value)) OnPropertyChanged(nameof(HasCalendarHint));
        }
    }

    public bool HasCalendarHint => !string.IsNullOrWhiteSpace(CalendarHint);

    public string DateText
    {
        get => _dateText;
        private set => SetProperty(ref _dateText, value);
    }

    public string GreetingText
    {
        get => _greetingText;
        private set => SetProperty(ref _greetingText, value);
    }

    public string WeatherText
    {
        get => _weatherText;
        private set => SetProperty(ref _weatherText, value);
    }

    public string UpdatedText
    {
        get => _updatedText;
        private set => SetProperty(ref _updatedText, value);
    }

    public DetailViewModel? SelectedDetail
    {
        get => _selectedDetail;
        private set
        {
            if (SetProperty(ref _selectedDetail, value)) OnPropertyChanged(nameof(HasDetail));
        }
    }

    public bool HasDetail => SelectedDetail is not null;
    public bool HasFocus => FocusItems.Count > 0;
    public bool HasTimeline => TimelineItems.Count > 0;
    public bool HasKnowledge => KnowledgeItems.Count > 0;
    public bool HasApprovals => Approvals.Count > 0;
    public bool IsEmpty => HasData && !HasFocus && !HasTimeline && !HasKnowledge && !HasApprovals;
    public int PendingApprovalCount => Approvals.Count;
    public string NotificationText => PendingApprovalCount > 0 ? $"通知 · {PendingApprovalCount}" : "通知";

    public async Task LoadAsync(bool refresh = false)
    {
        var client = _clientProvider();
        if (client is null)
        {
            ShowServiceUnavailable("本地服务尚未启动。");
            return;
        }
        if (refresh && HasData)
        {
            IsRefreshing = true;
        }
        else
        {
            IsLoading = true;
        }
        HasError = false;
        ErrorMessage = "";
        try
        {
            var response = await client.GetTodayAsync();
            Apply(response);
        }
        catch (Exception error)
        {
            HasError = true;
            ErrorMessage = DescribeError(error);
            if (!HasData)
            {
                ClearData();
                ApplyLocalDateFallback();
            }
        }
        finally
        {
            IsLoading = false;
            IsRefreshing = false;
            OnPropertyChanged(nameof(ShowInitialLoading));
        }
    }

    public void ShowServiceUnavailable(string message)
    {
        HasError = true;
        ErrorMessage = message;
        IsLoading = false;
        IsRefreshing = false;
        if (!HasData)
        {
            ClearData();
            ApplyLocalDateFallback();
        }
        OnPropertyChanged(nameof(ShowInitialLoading));
    }

    public void OpenFirstApproval()
    {
        if (Approvals.Count > 0)
        {
            SelectedDetail = DetailViewModel.FromApproval(Approvals[0]);
        }
        else
        {
            IsActionError = false;
            ActionMessage = "当前没有待审批操作。";
        }
    }

    public void CloseDetail() => SelectedDetail = null;

    private async Task ApproveSelectedAsync()
    {
        var approval = Approvals.FirstOrDefault(item => item.Approval.Id == SelectedDetail?.ObjectId);
        var client = _clientProvider();
        if (approval is null || client is null || IsApprovalBusy) return;
        var confirm = MessageBox.Show(
            $"即将写入 Google Calendar：\n\n{approval.Title}\n建议时间：{approval.ProposedText}\n\n" +
            "此操作会创建或修改外部日程。确认继续？",
            "确认审批",
            MessageBoxButton.OKCancel,
            MessageBoxImage.Warning);
        if (confirm != MessageBoxResult.OK) return;
        IsApprovalBusy = true;
        ActionMessage = "";
        try
        {
            var response = await client.ApproveAsync(approval.Approval.Id);
            IsActionError = response.Approval.Status != "executed";
            ActionMessage = response.Approval.Status == "executed"
                ? $"已写入 Google Calendar：{approval.Title}"
                : response.Approval.Error ?? "写入 Google Calendar 失败。";
            await LoadAsync(refresh: true);
        }
        catch (Exception error)
        {
            IsActionError = true;
            ActionMessage = DescribeError(error);
        }
        finally
        {
            IsApprovalBusy = false;
        }
    }

    private async Task RejectSelectedAsync()
    {
        var approval = Approvals.FirstOrDefault(item => item.Approval.Id == SelectedDetail?.ObjectId);
        var client = _clientProvider();
        if (approval is null || client is null || IsApprovalBusy) return;
        var confirm = MessageBox.Show(
            $"拒绝这个待审批操作？\n\n{approval.Title}\n{approval.ProposedText}\n\nGoogle Calendar 不会被修改。",
            "确认拒绝",
            MessageBoxButton.OKCancel,
            MessageBoxImage.Question);
        if (confirm != MessageBoxResult.OK) return;
        IsApprovalBusy = true;
        ActionMessage = "";
        try
        {
            await client.RejectAsync(approval.Approval.Id);
            IsActionError = false;
            ActionMessage = $"已拒绝操作：{approval.Title}";
            await LoadAsync(refresh: true);
        }
        catch (Exception error)
        {
            IsActionError = true;
            ActionMessage = DescribeError(error);
        }
        finally
        {
            IsApprovalBusy = false;
        }
    }

    private void Apply(TodayResponse response)
    {
        _timezone = string.IsNullOrWhiteSpace(response.Timezone) ? _timezone : response.Timezone;
        OnPropertyChanged(nameof(Timezone));
        HasData = true;
        IsPartial = response.Status == "partial";
        PartialMessage = BuildPartialMessage(response);
        CalendarHint = BuildCalendarHint(response);
        DateText = DisplayText.DateHeader(response.Date);
        GreetingText = DisplayText.Greeting(response.Timezone);
        WeatherText = response.Weather is null
            ? "天气暂不可用"
            : DisplayText.WeatherText(response.Weather.Temperature, response.Weather.Condition);
        UpdatedText = DisplayText.Updated(response.GeneratedAt, response.Date, response.Timezone);

        FocusItems.Clear();
        foreach (var item in response.FocusItems)
        {
            FocusItems.Add(new FocusItemViewModel(item, response.Timezone));
        }
        TimelineItems.Clear();
        foreach (var item in response.Timeline)
        {
            TimelineItems.Add(new TimelineItemViewModel(item, response.Timezone));
        }
        KnowledgeItems.Clear();
        foreach (var paper in response.KnowledgeItems)
        {
            KnowledgeItems.Add(new KnowledgeItemViewModel(paper));
        }
        Approvals.Clear();
        foreach (var approval in response.Approvals)
        {
            Approvals.Add(new ApprovalViewModel(approval, response.Timezone));
        }

        if (SelectedDetail is not null && !ObjectStillPresent(SelectedDetail.ObjectId))
        {
            SelectedDetail = null;
        }
        NotifyCollectionState();
    }

    private bool ObjectStillPresent(string? objectId)
    {
        if (string.IsNullOrWhiteSpace(objectId)) return true;
        return FocusItems.Any(item => item.Item.Id == objectId)
            || TimelineItems.Any(item => item.Item.Id == objectId || item.Item.LinkedObjectId == objectId)
            || KnowledgeItems.Any(item => item.Paper.Key == objectId)
            || Approvals.Any(item => item.Approval.Id == objectId);
    }

    private void ClearData()
    {
        HasData = false;
        IsPartial = false;
        PartialMessage = "";
        CalendarHint = "";
        FocusItems.Clear();
        TimelineItems.Clear();
        KnowledgeItems.Clear();
        Approvals.Clear();
        SelectedDetail = null;
        WeatherText = "天气暂不可用";
        UpdatedText = "尚未更新";
        NotifyCollectionState();
    }

    private void ApplyLocalDateFallback()
    {
        DateText = DisplayText.DateHeader(DateTime.Now.ToString("yyyy-MM-dd"));
        GreetingText = DisplayText.Greeting(TimeZoneInfo.Local.Id);
    }

    private void NotifyCollectionState()
    {
        OnPropertyChanged(nameof(HasFocus));
        OnPropertyChanged(nameof(HasTimeline));
        OnPropertyChanged(nameof(HasKnowledge));
        OnPropertyChanged(nameof(HasApprovals));
        OnPropertyChanged(nameof(IsEmpty));
        OnPropertyChanged(nameof(PendingApprovalCount));
        OnPropertyChanged(nameof(NotificationText));
    }

    private void SelectItem(object? parameter)
    {
        if (parameter is TimelineItemViewModel approvalTimeline &&
            approvalTimeline.SourceKey == "approval" &&
            approvalTimeline.Item.LinkedObjectId is { } approvalId)
        {
            var approval = Approvals.FirstOrDefault(item => item.Approval.Id == approvalId);
            if (approval is not null)
            {
                SelectedDetail = DetailViewModel.FromApproval(approval);
                return;
            }
        }
        SelectedDetail = parameter switch
        {
            FocusItemViewModel focus => DetailViewModel.FromFocus(focus, _timezone),
            TimelineItemViewModel timeline => DetailViewModel.FromTimeline(timeline, _timezone),
            KnowledgeItemViewModel paper => DetailViewModel.FromPaper(paper),
            ApprovalViewModel approval => DetailViewModel.FromApproval(approval),
            _ => SelectedDetail,
        };
    }

    private static string BuildPartialMessage(TodayResponse response)
    {
        var failures = response.Sources
            .Where(entry => entry.Value.State == "unavailable")
            .Select(entry =>
            {
                var label = entry.Key switch
                {
                    "calendar" => "Calendar",
                    "weather" => "天气",
                    "tasks" => "任务",
                    "lectures" => "讲座",
                    "knowledge" => "知识库",
                    "approvals" => "审批",
                    _ => entry.Key,
                };
                var detail = string.IsNullOrWhiteSpace(entry.Value.Message) ? "" : $"：{entry.Value.Message}";
                return $"{label}{detail}";
            })
            .ToList();
        return failures.Count == 0 ? "部分数据未更新。" : string.Join("；", failures);
    }

    private static string BuildCalendarHint(TodayResponse response)
    {
        return response.Sources.TryGetValue("calendar", out var calendar) &&
               calendar.State == "not_configured"
            ? "Google Calendar 尚未连接，时间线仅显示本地数据。"
            : "";
    }

    private static string DescribeError(Exception error)
    {
        return error switch
        {
            LocalApiException api => api.Message,
            TaskCanceledException => "本地服务响应超时，请重试。",
            HttpRequestException => "无法连接本地服务，请重试启动。",
            _ => error.Message,
        };
    }
}
