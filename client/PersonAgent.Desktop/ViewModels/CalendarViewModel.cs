using System.Collections.ObjectModel;
using System.Windows.Input;
using PersonAgent.Desktop.Models;
using PersonAgent.Desktop.Services;

namespace PersonAgent.Desktop.ViewModels;

public sealed class CalendarItemViewModel
{
    public CalendarItemViewModel(CalendarItem item, string timezone)
    {
        Item = item;
        TimeText = item.AllDay ? "全天" : DisplayText.TimeRange(item.StartAt, item.EndAt, timezone);
        SourceText = DisplayText.SourceLabel(item.Source);
        StatusText = item.Source switch
        {
            "google" => DisplayText.EventStatusLabel(item.Status),
            "task" => DisplayText.TaskStatusLabel(item.Status),
            "approval" => DisplayText.ApprovalStatusLabel(item.Status),
            "lecture" => item.Status == "active" ? "有效" : item.Status,
            _ => item.Status,
        };
    }

    public CalendarItem Item { get; }
    public string Title => Item.Title;
    public string TimeText { get; }
    public string SourceText { get; }
    public string StatusText { get; }
    public string SourceKey => Item.Source;
    public bool IsApproval => Item.Source == "approval";
    public bool Conflict => Item.Conflict;
}

public sealed class CalendarDayViewModel : ObservableObject
{
    public CalendarDayViewModel(DateOnly date, bool isToday)
    {
        Date = date;
        IsToday = isToday;
        Title = TimeZoneMath.DayTitle(date);
    }

    public DateOnly Date { get; }
    public string Title { get; }
    public bool IsToday { get; }
    public ObservableCollection<CalendarItemViewModel> Items { get; } = new();
    public bool HasItems => Items.Count > 0;

    public void NotifyItemsChanged() => OnPropertyChanged(nameof(HasItems));
}

public sealed class CalendarViewModel : PageViewModelBase
{
    private readonly Func<LocalApiClient?> _clientProvider;
    private readonly Func<string> _timezoneProvider;
    private readonly Action<DetailViewModel?> _setDetail;
    private DateOnly _weekStart;
    private string _weekTitle = "";
    private string _statusMessage = "";

    public CalendarViewModel(
        Func<LocalApiClient?> clientProvider,
        Func<string> timezoneProvider,
        Action<DetailViewModel?> setDetail)
    {
        _clientProvider = clientProvider;
        _timezoneProvider = timezoneProvider;
        _setDetail = setDetail;
        _weekStart = TimeZoneMath.WeekStart(TimeZoneMath.Today(_timezoneProvider()));
        RefreshCommand = new AsyncRelayCommand(() => LoadAsync(refresh: true));
        PreviousWeekCommand = new AsyncRelayCommand(() =>
        {
            _weekStart = _weekStart.AddDays(-7);
            return LoadAsync(refresh: true);
        });
        NextWeekCommand = new AsyncRelayCommand(() =>
        {
            _weekStart = _weekStart.AddDays(7);
            return LoadAsync(refresh: true);
        });
        CurrentWeekCommand = new AsyncRelayCommand(() =>
        {
            _weekStart = TimeZoneMath.WeekStart(TimeZoneMath.Today(_timezoneProvider()));
            return LoadAsync(refresh: true);
        });
        SelectItemCommand = new RelayCommand(SelectItem);
    }

    public ObservableCollection<CalendarDayViewModel> Days { get; } = new();
    public ICommand RefreshCommand { get; }
    public ICommand PreviousWeekCommand { get; }
    public ICommand NextWeekCommand { get; }
    public ICommand CurrentWeekCommand { get; }
    public ICommand SelectItemCommand { get; }

    public string WeekTitle
    {
        get => _weekTitle;
        private set => SetProperty(ref _weekTitle, value);
    }

    public string StatusMessage
    {
        get => _statusMessage;
        private set
        {
            if (SetProperty(ref _statusMessage, value)) OnPropertyChanged(nameof(HasStatusMessage));
        }
    }

    public bool HasStatusMessage => !string.IsNullOrWhiteSpace(StatusMessage);
    public bool IsEmpty => HasData && Days.All(day => !day.HasItems);

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
            var timezone = _timezoneProvider();
            var start = TimeZoneMath.LocalStart(_weekStart, timezone).ToUniversalTime();
            var end = TimeZoneMath.LocalStart(_weekStart.AddDays(7), timezone).ToUniversalTime();
            var response = await client.GetCalendarAsync(start.ToString("O"), end.ToString("O"));
            Days.Clear();
            for (var offset = 0; offset < 7; offset += 1)
            {
                var date = _weekStart.AddDays(offset);
                Days.Add(new CalendarDayViewModel(date, TimeZoneMath.IsToday(date, timezone)));
            }
            foreach (var item in response.Items)
            {
                var date = TimeZoneMath.ToLocalDate(item.StartAt, timezone);
                var day = Days.FirstOrDefault(candidate => candidate.Date == date);
                if (day is null) continue;
                day.Items.Add(new CalendarItemViewModel(item, timezone));
            }
            foreach (var day in Days)
            {
                day.NotifyItemsChanged();
            }
            WeekTitle = $"{TimeZoneMath.DayTitle(_weekStart)} – {TimeZoneMath.DayTitle(_weekStart.AddDays(6))}";
            IsPartial = response.Status == "partial";
            PartialMessage = string.Join(
                "；",
                response.Sources
                    .Where(entry => entry.Value.State == "unavailable")
                    .Select(entry => $"{DisplayText.ConnectionLabel(entry.Key == "calendar" ? "googleCalendar" : entry.Key)}{(string.IsNullOrWhiteSpace(entry.Value.Message) ? "" : $"：{entry.Value.Message}")}"));
            if (string.IsNullOrWhiteSpace(PartialMessage)) PartialMessage = "部分日历来源未更新。";
            HasData = true;
            OnPropertyChanged(nameof(IsEmpty));
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

    public override void CloseDetail() => _setDetail(null);

    public async Task SelectByIdAsync(string id)
    {
        if (!HasData) await LoadAsync();
        var item = Days.SelectMany(day => day.Items).FirstOrDefault(candidate =>
            candidate.Item.Id == id || candidate.Item.LinkedObjectId == id);
        if (item is null)
        {
            StatusMessage = "该对象不在当前周，可用上一周/下一周继续查找。";
            return;
        }
        SelectItem(item);
    }

    private void SelectItem(object? parameter)
    {
        if (parameter is not CalendarItemViewModel item) return;
        var rows = new List<DetailRow>
        {
            new("来源", item.SourceText),
            new("时间", item.TimeText),
            new("状态", item.StatusText),
        };
        if (item.Conflict)
        {
            rows.Add(new DetailRow("冲突", "服务端确认该安排需要重新规划。"));
        }
        if (!string.IsNullOrWhiteSpace(item.Item.LinkedObjectId))
        {
            rows.Add(new DetailRow("关联对象", item.Item.LinkedObjectId));
        }
        _setDetail(new DetailViewModel(
            item.Title,
            item.SourceText,
            item.StatusText,
            rows,
            item.IsApproval ? "该时段尚未写入 Google Calendar。" : null,
            objectId: item.Item.Id));
    }
}
