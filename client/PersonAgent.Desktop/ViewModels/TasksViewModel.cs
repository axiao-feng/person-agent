using System.Collections.ObjectModel;
using System.Windows.Input;
using PersonAgent.Desktop.Models;
using PersonAgent.Desktop.Services;

namespace PersonAgent.Desktop.ViewModels;

public sealed class TaskItemViewModel
{
    public TaskItemViewModel(TaskItem item, string timezone)
    {
        Item = item;
        TimeText = item.PlannedStart is not null
            ? DisplayText.TimeRange(item.PlannedStart, item.PlannedEnd, timezone)
            : item.Deadline is not null
                ? $"截止 {DisplayText.DateAndTime(item.Deadline, timezone)}"
                : "未设定时间";
    }

    public TaskItem Item { get; }
    public string Title => Item.Title;
    public string StatusText => DisplayText.TaskStatusLabel(Item.Status);
    public string StatusKey => Item.Status;
    public string KindText => DisplayText.TaskKindLabel(Item.TaskKind);
    public string PriorityText => DisplayText.PriorityLabel(Item.Priority);
    public string MetaText =>
        $"{KindText} · {Item.EstimatedMinutes} 分钟 · {PriorityText} · {DisplayText.SourceTypeLabel(Item.SourceType)}";
    public string TimeText { get; }
    public bool IsNeedsReplan => Item.Status == "needs_replan";
    public bool HasCalendar => Item.CalendarEventId is not null;
}

public sealed class TaskGroupViewModel
{
    public TaskGroupViewModel(string title, string hint)
    {
        Title = title;
        Hint = hint;
    }

    public string Title { get; }
    public string Hint { get; }
    public ObservableCollection<TaskItemViewModel> Items { get; } = new();
    public bool HasItems => Items.Count > 0;
}

public sealed class CandidateSlotViewModel
{
    public CandidateSlotViewModel(CandidateSlot slot, string timezone)
    {
        Slot = slot;
        TimeText = DisplayText.TimeRange(slot.StartAt, slot.EndAt, timezone);
    }

    public CandidateSlot Slot { get; }
    public string TimeText { get; }
    public string DurationText => $"{Slot.AvailableMinutes} 分钟可用";
}

public sealed class TaskDetailViewModel
{
    public TaskDetailViewModel(TaskItem item, string timezone)
    {
        Item = item;
        DeadlineText = item.Deadline is null ? "未设置" : DisplayText.DateAndTime(item.Deadline, timezone);
        PlannedText = item.PlannedStart is null
            ? "尚未安排"
            : DisplayText.TimeRange(item.PlannedStart, item.PlannedEnd, timezone);
        CalendarText = item.CalendarEventId is null ? "尚未同步到 Calendar" : "已同步到 Google Calendar";
    }

    public TaskItem Item { get; }
    public string Title => Item.Title;
    public string StatusText => DisplayText.TaskStatusLabel(Item.Status);
    public string KindText => DisplayText.TaskKindLabel(Item.TaskKind);
    public string SourceText => DisplayText.SourceTypeLabel(Item.SourceType);
    public string SourceIdText => Item.SourceId ?? "";
    public bool HasSourceId => !string.IsNullOrWhiteSpace(Item.SourceId);
    public string DeadlineText { get; }
    public string PlannedText { get; }
    public string CalendarText { get; }
    public string EstimateText => $"{Item.EstimatedMinutes} 分钟";
    public string PriorityText => DisplayText.PriorityLabel(Item.Priority);
    public bool CanStart => Item.Status is "draft" or "planned" or "needs_replan";
    public bool CanComplete => Item.Status == "in_progress";
    public bool CanCancel => Item.Status is not ("completed" or "cancelled");
    public bool CanSchedule => Item.Status is "draft" or "needs_replan";
    public bool CanEdit => Item.Status is not ("completed" or "cancelled");

    public IReadOnlyList<DetailRow> Rows => new[]
    {
        new DetailRow("类型", KindText),
        new DetailRow("来源", SourceText + (HasSourceId ? $" · {SourceIdText}" : "")),
        new DetailRow("截止", DeadlineText),
        new DetailRow("预计", EstimateText),
        new DetailRow("优先级", PriorityText),
        new DetailRow("计划时间", PlannedText),
        new DetailRow("Calendar", CalendarText),
    };
}

public sealed class TasksViewModel : PageViewModelBase
{
    private readonly Func<LocalApiClient?> _clientProvider;
    private readonly Func<string> _timezoneProvider;
    private readonly Action<DetailViewModel?> _setDetail;
    private readonly Action<TaskItem> _editRequested;
    private readonly Func<Task> _approvalCreated;
    private TaskDetailViewModel? _selectedDetail;
    private string _actionMessage = "";
    private bool _isActionError;
    private bool _isFindingSlots;
    private bool _isScheduling;
    private string _slotMessage = "";
    private string? _selectedTaskId;
    private bool _showCancelled;
    private IReadOnlyList<TaskItem> _lastTasks = Array.Empty<TaskItem>();

    public TasksViewModel(
        Func<LocalApiClient?> clientProvider,
        Func<string> timezoneProvider,
        Action<DetailViewModel?> setDetail,
        Action<TaskItem> editRequested,
        Func<Task> approvalCreated)
    {
        _clientProvider = clientProvider;
        _timezoneProvider = timezoneProvider;
        _setDetail = setDetail;
        _editRequested = editRequested;
        _approvalCreated = approvalCreated;
        RefreshCommand = new AsyncRelayCommand(() => LoadAsync(refresh: true));
        SelectTaskCommand = new RelayCommand(SelectTask);
        StartCommand = new AsyncRelayCommand(StartAsync);
        CompleteCommand = new AsyncRelayCommand(CompleteAsync);
        CancelCommand = new AsyncRelayCommand(CancelAsync);
        FindSlotsCommand = new AsyncRelayCommand(FindSlotsAsync);
        ScheduleSlotCommand = new RelayCommand(parameter => _ = ScheduleSlotAsync(parameter));
        EditCommand = new RelayCommand(() =>
        {
            if (SelectedDetail is not null) _editRequested(SelectedDetail.Item);
        });
        NewTaskCommand = new RelayCommand(() => _editRequested(new TaskItem()));
    }

    public ObservableCollection<TaskGroupViewModel> Groups { get; } = new();
    public ObservableCollection<CandidateSlotViewModel> Slots { get; } = new();

    public ICommand RefreshCommand { get; }
    public ICommand SelectTaskCommand { get; }
    public ICommand StartCommand { get; }
    public ICommand CompleteCommand { get; }
    public ICommand CancelCommand { get; }
    public ICommand FindSlotsCommand { get; }
    public ICommand ScheduleSlotCommand { get; }
    public ICommand EditCommand { get; }
    public ICommand NewTaskCommand { get; }

    public TaskDetailViewModel? SelectedDetail
    {
        get => _selectedDetail;
        private set
        {
            if (SetProperty(ref _selectedDetail, value)) OnPropertyChanged(nameof(HasDetail));
        }
    }

    public bool HasDetail => SelectedDetail is not null;
    public bool HasGroups => Groups.Count > 0;
    public bool HasSlots => Slots.Count > 0;

    public string ActionMessage
    {
        get => _actionMessage;
        private set
        {
            if (SetProperty(ref _actionMessage, value)) OnPropertyChanged(nameof(HasActionMessage));
        }
    }

    public bool HasActionMessage => !string.IsNullOrWhiteSpace(ActionMessage);

    public bool ShowCancelled
    {
        get => _showCancelled;
        set
        {
            if (!SetProperty(ref _showCancelled, value)) return;
            if (HasData) Apply(_lastTasks);
        }
    }

    public bool IsActionError
    {
        get => _isActionError;
        private set => SetProperty(ref _isActionError, value);
    }

    public bool IsFindingSlots
    {
        get => _isFindingSlots;
        private set => SetProperty(ref _isFindingSlots, value);
    }

    public bool IsScheduling
    {
        get => _isScheduling;
        private set => SetProperty(ref _isScheduling, value);
    }

    public string SlotMessage
    {
        get => _slotMessage;
        private set
        {
            if (SetProperty(ref _slotMessage, value)) OnPropertyChanged(nameof(HasSlotMessage));
        }
    }

    public bool HasSlotMessage => !string.IsNullOrWhiteSpace(SlotMessage);

    public override async Task LoadAsync(bool refresh = false)
    {
        var client = _clientProvider();
        if (client is null)
        {
            SetError(new InvalidOperationException("本地服务尚未启动。"));
            EndLoad();
            return;
        }
        BeginLoad(refresh);
        try
        {
            var response = await client.GetTasksAsync();
            _lastTasks = response.Items;
            Apply(response.Items);
            HasData = true;
        }
        catch (Exception error)
        {
            SetError(error);
        }
        finally
        {
            EndLoad();
        }
    }

    public override void CloseDetail()
    {
        SelectedDetail = null;
        Slots.Clear();
        OnPropertyChanged(nameof(HasSlots));
        SlotMessage = "";
        _setDetail(null);
    }

    public async Task SelectByIdAsync(string id)
    {
        if (!HasData) await LoadAsync();
        var item = Groups.SelectMany(group => group.Items)
            .FirstOrDefault(candidate => candidate.Item.Id == id);
        if (item is null)
        {
            await LoadAsync(refresh: true);
            item = Groups.SelectMany(group => group.Items)
                .FirstOrDefault(candidate => candidate.Item.Id == id);
        }
        if (item is not null) SelectTask(item);
    }

    private void Apply(IReadOnlyList<TaskItem> tasks)
    {
        var timezone = _timezoneProvider();
        Groups.Clear();
        var unscheduled = new TaskGroupViewModel("待安排", "草稿和需要重排的任务");
        var active = new TaskGroupViewModel("已计划 / 进行中", "已有时间安排或正在执行");
        var completed = new TaskGroupViewModel("最近完成", "默认显示最近完成的项目");
        var cancelled = new TaskGroupViewModel("已取消", "仅在选择显示时出现");
        foreach (var task in tasks)
        {
            var item = new TaskItemViewModel(task, timezone);
            switch (task.Status)
            {
                case "draft":
                case "needs_replan":
                    unscheduled.Items.Add(item);
                    break;
                case "planned":
                case "in_progress":
                    active.Items.Add(item);
                    break;
                case "completed":
                    completed.Items.Add(item);
                    break;
                case "cancelled":
                    cancelled.Items.Add(item);
                    break;
            }
        }
        Sort(unscheduled.Items, item => item.Item.Status == "needs_replan" ? 0 : 1, item => item.Item.Deadline);
        Sort(active.Items, item => item.Item.PlannedStart is null ? 1 : 0, item => item.Item.PlannedStart);
        var recent = completed.Items
            .OrderByDescending(item => item.Item.UpdatedAt, StringComparer.Ordinal)
            .Take(20)
            .ToList();
        completed.Items.Clear();
        foreach (var item in recent) completed.Items.Add(item);
        if (unscheduled.Items.Count > 0) Groups.Add(unscheduled);
        if (active.Items.Count > 0) Groups.Add(active);
        if (completed.Items.Count > 0) Groups.Add(completed);
        if (ShowCancelled && cancelled.Items.Count > 0) Groups.Add(cancelled);
        OnPropertyChanged(nameof(HasGroups));

        if (_selectedTaskId is not null)
        {
            var selected = tasks.FirstOrDefault(task => task.Id == _selectedTaskId);
            if (selected is null)
            {
                SelectedDetail = null;
                _setDetail(null);
            }
            else
            {
                SelectedDetail = new TaskDetailViewModel(selected, timezone);
                _setDetail(BuildDetail(SelectedDetail));
            }
        }
    }

    private static void Sort(
        ObservableCollection<TaskItemViewModel> items,
        Func<TaskItemViewModel, int> first,
        Func<TaskItemViewModel, string?> key)
    {
        var sorted = items
            .OrderBy(first)
            .ThenBy(item => key(item) ?? "9999")
            .ThenBy(item => item.Item.CreatedAt, StringComparer.Ordinal)
            .ToList();
        items.Clear();
        foreach (var item in sorted) items.Add(item);
    }

    private void SelectTask(object? parameter)
    {
        if (parameter is not TaskItemViewModel item) return;
        _selectedTaskId = item.Item.Id;
        SelectedDetail = new TaskDetailViewModel(item.Item, _timezoneProvider());
        Slots.Clear();
        OnPropertyChanged(nameof(HasSlots));
        SlotMessage = "";
        _setDetail(BuildDetail(SelectedDetail));
    }

    private async Task StartAsync() => await RunCommand("start");
    private async Task CompleteAsync() => await RunCommand("complete");
    private async Task CancelAsync() => await RunCommand("cancel");

    private async Task RunCommand(string operation)
    {
        var client = _clientProvider();
        if (client is null || SelectedDetail is null) return;
        if (operation == "cancel")
        {
            var confirm = System.Windows.MessageBox.Show(
                $"取消任务“{SelectedDetail.Title}”？",
                "确认取消",
                System.Windows.MessageBoxButton.OKCancel,
                System.Windows.MessageBoxImage.Question);
            if (confirm != System.Windows.MessageBoxResult.OK) return;
        }
        IsActionError = false;
        ActionMessage = "";
        try
        {
            var response = await client.TaskCommandAsync(SelectedDetail.Item.Id, operation);
            ActionMessage = $"任务已更新：{DisplayText.TaskStatusLabel(response.Task.Status)}";
            await LoadAsync(refresh: true);
        }
        catch (Exception error)
        {
            IsActionError = true;
            ActionMessage = DescribeError(error);
        }
    }

    private async Task FindSlotsAsync()
    {
        var client = _clientProvider();
        if (client is null || SelectedDetail is null) return;
        var now = DateTimeOffset.UtcNow;
        var end = SelectedDetail.Item.Deadline is { } deadline &&
                  DateTimeOffset.TryParse(deadline, out var parsed) &&
                  parsed > now
            ? parsed
            : now.AddDays(7);
        if (end > now.AddDays(31)) end = now.AddDays(31);
        IsFindingSlots = true;
        SlotMessage = "";
        Slots.Clear();
        OnPropertyChanged(nameof(HasSlots));
        try
        {
            var response = await client.GetCandidateSlotsAsync(
                SelectedDetail.Item.Id,
                now.ToString("O"),
                end.ToString("O"));
            foreach (var slot in response.Slots)
            {
                Slots.Add(new CandidateSlotViewModel(slot, _timezoneProvider()));
            }
            OnPropertyChanged(nameof(HasSlots));
            SlotMessage = response.Slots.Count == 0
                ? "截止时间前没有找到足够的空闲时段。"
                : "选择一个时段后会生成待审批操作，不会直接写入 Calendar。";
        }
        catch (Exception error)
        {
            SlotMessage = DescribeError(error);
        }
        finally
        {
            IsFindingSlots = false;
        }
    }

    private async Task ScheduleSlotAsync(object? parameter)
    {
        var client = _clientProvider();
        if (client is null || SelectedDetail is null || parameter is not CandidateSlotViewModel slot) return;
        IsScheduling = true;
        SlotMessage = "";
        try
        {
            await client.ScheduleTaskAsync(
                SelectedDetail.Item.Id,
                slot.Slot.StartAt,
                slot.Slot.EndAt);
            IsActionError = false;
            ActionMessage = "已生成待审批操作。请到“今日”页面确认后写入 Google Calendar。";
            Slots.Clear();
            OnPropertyChanged(nameof(HasSlots));
            await _approvalCreated();
        }
        catch (Exception error)
        {
            SlotMessage = DescribeError(error);
        }
        finally
        {
            IsScheduling = false;
        }
    }

    private DetailViewModel BuildDetail(TaskDetailViewModel task)
    {
        return new DetailViewModel(
            task.Title,
            "任务",
            task.StatusText,
            task.Rows,
            objectId: task.Item.Id);
    }
}
