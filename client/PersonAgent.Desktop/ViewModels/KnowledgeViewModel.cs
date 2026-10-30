using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Windows;
using System.Windows.Input;
using PersonAgent.Desktop.Models;
using PersonAgent.Desktop.Services;

namespace PersonAgent.Desktop.ViewModels;

public sealed class KnowledgeFilterViewModel : ObservableObject
{
    private int _count;

    public KnowledgeFilterViewModel(string key, string label)
    {
        Key = key;
        Label = label;
    }

    public string Key { get; }
    public string Label { get; }
    public int Count
    {
        get => _count;
        set
        {
            if (SetProperty(ref _count, value)) OnPropertyChanged(nameof(Text));
        }
    }

    public string Text => Key == "all" ? $"全部 {Count}" : $"{Label} {Count}";
}

public sealed class PaperDetailViewModel
{
    public PaperDetailViewModel(PaperDetail paper, string timezone)
    {
        Paper = paper;
        RetryText = paper.RetryAt is null
            ? ""
            : $"下次重试：{DisplayText.DateAndTime(paper.RetryAt, timezone)}";
    }

    public PaperDetail Paper { get; }
    public string Title => string.IsNullOrWhiteSpace(Paper.Title) ? "无标题" : Paper.Title;
    public string CreatorsText => DisplayText.CreatorsText(Paper.Creators);
    public string DateText => Paper.DateText ?? "日期未知";
    public string TagsText => Paper.Tags.Count == 0 ? "无标签" : string.Join(" · ", Paper.Tags);
    public string EvidenceText => DisplayText.EvidenceLabel(Paper.EvidenceState);
    public string EvidenceKey => Paper.EvidenceState;
    public string DirectionText => Paper.Analysis?.Direction is { Length: > 0 } value ? value : "尚未生成分析。";
    public string ResultsText => Paper.Analysis?.Results is { Length: > 0 } value ? value : "尚未生成分析。";
    public string LimitationsText => Paper.Analysis?.Limitations is { Length: > 0 } value ? value : "尚未生成分析。";
    public string BasisText => Paper.Analysis is null
        ? "尚无分析依据"
        : Paper.Analysis.Truncated
            ? $"{Paper.Analysis.Basis}（正文过长，使用头尾采样）".Trim()
            : Paper.Analysis.Basis;
    public string AbstractText => Paper.Abstract ?? "没有摘要。";
    public string? AnalysisError => Paper.AnalysisError;
    public bool HasError => !string.IsNullOrWhiteSpace(Paper.AnalysisError);
    public string RetryText { get; }
    public bool HasRetry => Paper.RetryAt is not null;
    public string? ZoteroLink => Paper.Links.Zotero;
    public string? ObsidianLink => Paper.Links.Obsidian;
    public bool HasObsidianLink => !string.IsNullOrWhiteSpace(Paper.Links.Obsidian);
}

public sealed class KnowledgeViewModel : PageViewModelBase
{
    private readonly Func<LocalApiClient?> _clientProvider;
    private readonly Func<string> _timezoneProvider;
    private readonly Action<DetailViewModel?> _setDetail;
    private KnowledgeFilterViewModel? _selectedFilter;
    private PaperDetailViewModel? _selectedPaper;
    private bool _isOperationRunning;
    private string _operationMessage = "";
    private bool _isOperationError;
    private bool _suppressFilterLoad;

    public KnowledgeViewModel(
        Func<LocalApiClient?> clientProvider,
        Func<string> timezoneProvider,
        Action<DetailViewModel?> setDetail)
    {
        _clientProvider = clientProvider;
        _timezoneProvider = timezoneProvider;
        _setDetail = setDetail;
        _suppressFilterLoad = true;
        foreach (var (key, label) in new[]
                 {
                     ("all", "全部"),
                     ("pending", "待分析"),
                     ("retrying", "重试等待"),
                     ("partial", "仅摘要"),
                     ("complete", "已完成"),
                 })
        {
            Filters.Add(new KnowledgeFilterViewModel(key, label));
        }
        _selectedFilter = Filters[0];
        _suppressFilterLoad = false;

        RefreshCommand = new AsyncRelayCommand(() => LoadAsync(refresh: true));
        SelectPaperCommand = new RelayCommand(parameter =>
        {
            if (parameter is KnowledgeItemViewModel item) _ = SelectPaperAsync(item.Paper);
        });
        OpenZoteroCommand = new RelayCommand(() => OpenUri(SelectedPaper?.ZoteroLink));
        OpenObsidianCommand = new RelayCommand(() => OpenUri(SelectedPaper?.ObsidianLink));
        SyncCommand = new AsyncRelayCommand(() => RunOperationAsync(digest: false));
        DigestCommand = new AsyncRelayCommand(() => RunOperationAsync(digest: true));
        CloseDetailCommand = new RelayCommand(CloseDetail);
    }

    public ObservableCollection<KnowledgeFilterViewModel> Filters { get; } = new();
    public ObservableCollection<KnowledgeItemViewModel> Papers { get; } = new();

    public ICommand RefreshCommand { get; }
    public ICommand SelectPaperCommand { get; }
    public ICommand OpenZoteroCommand { get; }
    public ICommand OpenObsidianCommand { get; }
    public ICommand SyncCommand { get; }
    public ICommand DigestCommand { get; }
    public ICommand CloseDetailCommand { get; }

    public KnowledgeFilterViewModel? SelectedFilter
    {
        get => _selectedFilter;
        set
        {
            if (!SetProperty(ref _selectedFilter, value) || value is null || _suppressFilterLoad) return;
            _ = LoadAsync(refresh: true);
        }
    }

    public PaperDetailViewModel? SelectedPaper
    {
        get => _selectedPaper;
        private set
        {
            if (SetProperty(ref _selectedPaper, value)) OnPropertyChanged(nameof(HasDetail));
        }
    }

    public bool HasDetail => SelectedPaper is not null;
    public bool HasPapers => Papers.Count > 0;
    public bool IsEmpty => HasData && Papers.Count == 0;

    public bool IsOperationRunning
    {
        get => _isOperationRunning;
        private set => SetProperty(ref _isOperationRunning, value);
    }

    public string OperationMessage
    {
        get => _operationMessage;
        private set
        {
            if (SetProperty(ref _operationMessage, value)) OnPropertyChanged(nameof(HasOperationMessage));
        }
    }

    public bool HasOperationMessage => !string.IsNullOrWhiteSpace(OperationMessage);

    public bool IsOperationError
    {
        get => _isOperationError;
        private set => SetProperty(ref _isOperationError, value);
    }

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
            var state = SelectedFilter?.Key == "all" ? null : SelectedFilter?.Key;
            var response = await client.GetPapersAsync(state: state);
            Papers.Clear();
            foreach (var paper in response.Items)
            {
                Papers.Add(new KnowledgeItemViewModel(paper));
            }
            UpdateCounts(response.Counts);
            HasData = true;
            OnPropertyChanged(nameof(HasPapers));
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

    public override void CloseDetail()
    {
        SelectedPaper = null;
        _setDetail(null);
    }

    public async Task SelectByKeyAsync(string key)
    {
        if (!HasData) await LoadAsync();
        var item = Papers.FirstOrDefault(candidate => candidate.Paper.Key == key);
        if (item is null)
        {
            _suppressFilterLoad = true;
            SelectedFilter = Filters[0];
            _suppressFilterLoad = false;
            await LoadAsync(refresh: true);
            item = Papers.FirstOrDefault(candidate => candidate.Paper.Key == key);
        }
        if (item is not null) await SelectPaperAsync(item.Paper);
    }

    private async Task SelectPaperAsync(PaperSummary summary)
    {
        var client = _clientProvider();
        if (client is null) return;
        try
        {
            var response = await client.GetPaperAsync(summary.Key);
            SelectedPaper = new PaperDetailViewModel(response.Paper, _timezoneProvider());
            _setDetail(null);
        }
        catch (Exception error)
        {
            SetError(error);
        }
    }

    private async Task RunOperationAsync(bool digest)
    {
        var client = _clientProvider();
        if (client is null || IsOperationRunning) return;
        IsOperationRunning = true;
        IsOperationError = false;
        OperationMessage = digest ? "正在启动知识整理…" : "正在启动 Zotero 同步…";
        try
        {
            var started = digest
                ? await client.StartKnowledgeDigestAsync()
                : await client.StartKnowledgeSyncAsync();
            var operation = started.Operation;
            OperationMessage = DescribeOperation(operation);
            var deadline = DateTimeOffset.UtcNow.AddMinutes(30);
            while (DateTimeOffset.UtcNow < deadline)
            {
                await Task.Delay(TimeSpan.FromSeconds(1.5));
                operation = (await client.GetOperationAsync(operation.Id)).Operation;
                OperationMessage = DescribeOperation(operation);
                if (operation.Status is "succeeded" or "failed") break;
            }
            if (operation.Status == "succeeded")
            {
                OperationMessage = digest ? "知识整理完成。" : "Zotero 同步完成。";
                await LoadAsync(refresh: true);
            }
            else if (operation.Status == "failed")
            {
                IsOperationError = true;
                OperationMessage = operation.Error ?? "知识任务失败。";
            }
            else
            {
                IsOperationError = true;
                OperationMessage = "操作仍在后台运行，稍后可刷新查看结果。";
            }
        }
        catch (Exception error)
        {
            IsOperationError = true;
            OperationMessage = DescribeError(error);
        }
        finally
        {
            IsOperationRunning = false;
        }
    }

    private static string DescribeOperation(Operation operation)
    {
        var stage = DisplayText.OperationStageLabel(operation.Stage);
        var status = DisplayText.OperationStatusLabel(operation.Status);
        return string.IsNullOrWhiteSpace(stage) ? status : $"{status} · {stage}";
    }

    private void UpdateCounts(PaperCounts counts)
    {
        SetCount("all", counts.Pending + counts.Retrying + counts.Partial + counts.Complete);
        SetCount("pending", counts.Pending);
        SetCount("retrying", counts.Retrying);
        SetCount("partial", counts.Partial);
        SetCount("complete", counts.Complete);
    }

    private void SetCount(string key, int count)
    {
        var filter = Filters.FirstOrDefault(item => item.Key == key);
        if (filter is not null) filter.Count = count;
    }

    private static void OpenUri(string? uri)
    {
        if (string.IsNullOrWhiteSpace(uri) ||
            !Uri.TryCreate(uri, UriKind.Absolute, out var parsed) ||
            (parsed.Scheme != "zotero" && parsed.Scheme != "obsidian"))
        {
            MessageBox.Show("没有可用的打开链接。", "Person Agent", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        try
        {
            var startInfo = new ProcessStartInfo(uri) { UseShellExecute = true };
            Process.Start(startInfo);
        }
        catch (Exception error)
        {
            MessageBox.Show($"无法打开链接：{error.Message}", "Person Agent", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }
}
