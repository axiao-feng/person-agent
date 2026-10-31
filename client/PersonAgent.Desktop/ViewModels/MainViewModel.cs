using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Input;
using System.Windows.Threading;
using PersonAgent.Desktop.Models;
using PersonAgent.Desktop.Services;
using PersonAgent.Desktop.Views;

namespace PersonAgent.Desktop.ViewModels;

public sealed class MainViewModel : ObservableObject, IDisposable
{
    private readonly DispatcherTimer _refreshTimer;
    private BackendSession? _session;
    private LocalApiClient? _client;
    private NavItemViewModel? _selectedSection;
    private object? _activePage;
    private DetailViewModel? _selectedDetail;
    private bool _isConnecting;
    private bool _isServiceConnected;
    private bool _hasStartupError;
    private string _startupErrorText = "";
    private string _serviceStatusText = "正在启动本地服务…";
    private string _workerStatusText = "后台任务状态未知";
    private bool _suppressSectionLoad;
    private bool _disposed;

    public MainViewModel()
    {
        Today = new TodayViewModel(() => _client, RetryStartupAsync, OpenDiagnostics);
        Knowledge = new KnowledgeViewModel(() => _client, () => Today.Timezone, SetDetail);
        Tasks = new TasksViewModel(
            () => _client,
            () => Today.Timezone,
            SetDetail,
            EditTaskRequested,
            RefreshTodayAsync);
        Calendar = new CalendarViewModel(() => _client, () => Today.Timezone, SetDetail);
        Settings = new SettingsViewModel(() => _client, OpenDiagnostics);

        Today.PropertyChanged += (_, args) =>
        {
            if (args.PropertyName == nameof(TodayViewModel.SelectedDetail))
            {
                SelectedDetail = Today.SelectedDetail;
            }
        };

        Sections = new ObservableCollection<NavItemViewModel>
        {
            new("今日", Today),
            new("知识库", Knowledge),
            new("任务", Tasks),
            new("日历", Calendar),
            new("设置", Settings),
        };
        _selectedSection = Sections[0];
        _activePage = Today;

        RetryStartupCommand = new AsyncRelayCommand(RetryStartupAsync);
        DiagnosticsCommand = new RelayCommand(OpenDiagnostics);
        ShowApprovalsCommand = new AsyncRelayCommand(async () =>
        {
            SelectedSection = Sections[0];
            await Today.LoadAsync();
            Today.OpenFirstApproval();
        });
        CloseDetailCommand = new RelayCommand(CloseDetail);
        QuickCaptureCommand = new RelayCommand(() => OpenQuickCapture("idea"));
        ShowCommandPaletteCommand = new RelayCommand(ShowCommandPalette);
        RefreshCurrentCommand = new AsyncRelayCommand(RefreshAllAsync);

        _refreshTimer = new DispatcherTimer
        {
            Interval = TimeSpan.FromSeconds(60),
        };
        _refreshTimer.Tick += OnRefreshTimerTick;
    }

    public TodayViewModel Today { get; }
    public KnowledgeViewModel Knowledge { get; }
    public TasksViewModel Tasks { get; }
    public CalendarViewModel Calendar { get; }
    public SettingsViewModel Settings { get; }
    public ObservableCollection<NavItemViewModel> Sections { get; }
    public ICommand RetryStartupCommand { get; }
    public ICommand DiagnosticsCommand { get; }
    public ICommand ShowApprovalsCommand { get; }
    public ICommand CloseDetailCommand { get; }
    public ICommand QuickCaptureCommand { get; }
    public ICommand ShowCommandPaletteCommand { get; }
    public ICommand RefreshCurrentCommand { get; }

    public NavItemViewModel? SelectedSection
    {
        get => _selectedSection;
        set
        {
            var previous = _selectedSection;
            if (!SetProperty(ref _selectedSection, value)) return;
            if (previous?.Page is IWorkspacePage oldPage) oldPage.CloseDetail();
            ActivePage = value?.Page;
            SelectedDetail = null;
            if (value?.Page is IWorkspacePage page && !_suppressSectionLoad)
            {
                _ = page.LoadAsync();
            }
        }
    }

    public object? ActivePage
    {
        get => _activePage;
        private set => SetProperty(ref _activePage, value);
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

    public bool IsConnecting
    {
        get => _isConnecting;
        private set => SetProperty(ref _isConnecting, value);
    }

    public bool IsServiceConnected
    {
        get => _isServiceConnected;
        private set => SetProperty(ref _isServiceConnected, value);
    }

    public bool HasStartupError
    {
        get => _hasStartupError;
        private set => SetProperty(ref _hasStartupError, value);
    }

    public string StartupErrorText
    {
        get => _startupErrorText;
        private set => SetProperty(ref _startupErrorText, value);
    }

    public string ServiceStatusText
    {
        get => _serviceStatusText;
        private set => SetProperty(ref _serviceStatusText, value);
    }

    public string WorkerStatusText
    {
        get => _workerStatusText;
        private set => SetProperty(ref _workerStatusText, value);
    }

    public async Task InitializeAsync()
    {
        await StartBackendAsync();
    }

    public async Task RetryStartupAsync()
    {
        await StartBackendAsync();
    }

    public async Task RefreshTodayAsync()
    {
        await Today.LoadAsync(refresh: true);
    }

    public async Task RefreshAllAsync()
    {
        await Today.LoadAsync(refresh: true);
        if (ActivePage is IWorkspacePage page && !ReferenceEquals(page, Today))
        {
            await page.LoadAsync(refresh: true);
        }
        await RefreshHealthAsync();
    }

    public async Task OpenDeepLinkAsync(DeepLink link)
    {
        if (link.Kind == DeepLinkKind.Activate) return;
        if (_client is null && !IsConnecting)
        {
            await StartBackendAsync();
        }
        switch (link.Kind)
        {
            case DeepLinkKind.Today:
                await NavigateAsync(0);
                break;
            case DeepLinkKind.Approval:
                await NavigateAsync(0, load: false);
                await Today.LoadAsync(refresh: true);
                if (!string.IsNullOrWhiteSpace(link.ObjectId))
                {
                    Today.OpenApproval(link.ObjectId);
                }
                break;
            case DeepLinkKind.Lecture:
                await NavigateAsync(3);
                if (!string.IsNullOrWhiteSpace(link.ObjectId))
                {
                    await Calendar.SelectByIdAsync(link.ObjectId);
                }
                break;
        }
    }

    private async Task NavigateAsync(int sectionIndex, bool load = true)
    {
        if (sectionIndex < 0 || sectionIndex >= Sections.Count) return;
        var section = Sections[sectionIndex];
        if (!ReferenceEquals(SelectedSection, section))
        {
            _suppressSectionLoad = true;
            try
            {
                SelectedSection = section;
            }
            finally
            {
                _suppressSectionLoad = false;
            }
        }
        if (load && section.Page is IWorkspacePage page)
        {
            await page.LoadAsync();
        }
    }

    public async Task ShutdownAsync()
    {
        _refreshTimer.Stop();
        var client = _client;
        _client = null;
        client?.Dispose();
        var session = _session;
        _session = null;
        if (session is not null)
        {
            await session.DisposeAsync().ConfigureAwait(false);
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        ShutdownAsync().GetAwaiter().GetResult();
    }

    private void SetDetail(DetailViewModel? detail)
    {
        SelectedDetail = detail;
    }

    private void CloseDetail()
    {
        Today.CloseDetail();
        if (ActivePage is IWorkspacePage page && !ReferenceEquals(page, Today))
        {
            page.CloseDetail();
        }
        SelectedDetail = null;
    }

    private async Task StartBackendAsync()
    {
        if (IsConnecting) return;
        IsConnecting = true;
        HasStartupError = false;
        StartupErrorText = "";
        ServiceStatusText = "正在启动本地服务…";
        try
        {
            await StopBackendAsync();
            _session = await BackendLauncher.StartAsync();
            _client = new LocalApiClient(_session.Port, _session.Token);
            IsServiceConnected = true;
            ServiceStatusText = "本地服务已连接";
            await Task.WhenAll(Today.LoadAsync(), RefreshHealthAsync());
            if (ActivePage is IWorkspacePage page && !ReferenceEquals(page, Today))
            {
                await page.LoadAsync();
            }
            _refreshTimer.Start();
        }
        catch (Exception error)
        {
            IsServiceConnected = false;
            HasStartupError = true;
            StartupErrorText = error.Message;
            ServiceStatusText = "本地服务未启动";
            WorkerStatusText = "后台任务状态未知";
            Today.ShowServiceUnavailable(error.Message);
            await StopBackendAsync();
        }
        finally
        {
            IsConnecting = false;
        }
    }

    private async Task StopBackendAsync()
    {
        var client = _client;
        _client = null;
        client?.Dispose();
        var session = _session;
        _session = null;
        if (session is not null)
        {
            await session.DisposeAsync();
        }
    }

    private async Task RefreshHealthAsync()
    {
        var client = _client;
        if (client is null) return;
        try
        {
            var health = await client.GetHealthAsync();
            IsServiceConnected = true;
            ServiceStatusText = health.Status == "degraded"
                ? $"本地服务已连接 · v{health.Service.Version}（部分连接不可用）"
                : $"本地服务已连接 · v{health.Service.Version}";
            WorkerStatusText = health.Worker.State switch
            {
                "running" => "后台任务运行中",
                "stopped" => "后台任务未运行",
                "not_installed" => "后台任务未安装",
                _ => "后台任务状态未知",
            };
        }
        catch (Exception)
        {
            ServiceStatusText = "本地服务连接中断";
            WorkerStatusText = "后台任务状态未知";
            if (!Today.HasData)
            {
                Today.ShowServiceUnavailable("本地服务连接中断，请重试启动。");
            }
        }
    }

    private async void OnRefreshTimerTick(object? sender, EventArgs e)
    {
        if (!IsServiceConnected) return;
        try
        {
            await Today.LoadAsync(refresh: true);
            if (ActivePage is IWorkspacePage page && !ReferenceEquals(page, Today))
            {
                await page.LoadAsync(refresh: true);
            }
            await RefreshHealthAsync();
        }
        catch
        {
            // Each page shows its own error state and keeps the last successful data.
        }
    }

    private void OpenQuickCapture(string initialType)
    {
        App.LogEvent($"quick_capture_requested:{initialType}");
        var client = _client;
        if (client is null)
        {
            MessageBox.Show("本地服务尚未启动。", "Person Agent", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        var window = new QuickCaptureWindow(client, Today.Timezone, initialType)
        {
            Owner = Application.Current.MainWindow,
        };
        App.LogEvent("quick_capture_shown");
        var result = window.ShowDialog();
        App.LogEvent($"quick_capture_closed:{result}");
        if (result == true)
        {
            _ = RefreshAllAsync();
        }
    }

    private void EditTaskRequested(TaskItem task)
    {
        var client = _client;
        if (client is null)
        {
            MessageBox.Show("本地服务尚未启动。", "Person Agent", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        if (string.IsNullOrWhiteSpace(task.Id))
        {
            OpenQuickCapture("task");
            return;
        }
        var window = new TaskEditWindow(client, Today.Timezone, task)
        {
            Owner = Application.Current.MainWindow,
        };
        if (window.ShowDialog() == true)
        {
            _ = RefreshAllAsync();
        }
    }

    private void ShowCommandPalette()
    {
        App.LogEvent("command_palette_requested");
        var client = _client;
        if (client is null)
        {
            MessageBox.Show("本地服务尚未启动。", "Person Agent", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        var window = new CommandPaletteWindow(client, OpenSearchResultAsync, () => OpenQuickCapture("idea"))
        {
            Owner = Application.Current.MainWindow,
        };
        App.LogEvent("command_palette_shown");
        window.ShowDialog();
    }

    private async Task OpenSearchResultAsync(SearchResult result)
    {
        switch (result.Type)
        {
            case "task":
                SelectedSection = Sections[2];
                await Tasks.SelectByIdAsync(result.Id);
                break;
            case "paper":
                SelectedSection = Sections[1];
                await Knowledge.SelectByKeyAsync(result.Id);
                break;
            case "lecture":
                SelectedSection = Sections[3];
                await Calendar.SelectByIdAsync(result.Id);
                break;
            case "idea":
                OpenExternalUri(result.OpenTarget);
                break;
        }
    }

    private static void OpenExternalUri(string? uri)
    {
        if (string.IsNullOrWhiteSpace(uri) ||
            !Uri.TryCreate(uri, UriKind.Absolute, out var parsed) ||
            (parsed.Scheme != "obsidian" && parsed.Scheme != "zotero"))
        {
            MessageBox.Show("没有可用的打开链接。", "Person Agent", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        try
        {
            Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
        }
        catch (Exception error)
        {
            MessageBox.Show($"无法打开链接：{error.Message}", "Person Agent", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void OpenDiagnostics()
    {
        try
        {
            var folder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "person-agent");
            Directory.CreateDirectory(folder);
            var startInfo = new ProcessStartInfo("explorer.exe")
            {
                UseShellExecute = true,
            };
            startInfo.ArgumentList.Add(folder);
            Process.Start(startInfo);
        }
        catch (Exception error)
        {
            MessageBox.Show(
                $"无法打开诊断目录：{error.Message}",
                "Person Agent",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }
    }
}
