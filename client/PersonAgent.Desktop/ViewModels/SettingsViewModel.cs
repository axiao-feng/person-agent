using System.Collections.ObjectModel;
using System.Windows.Input;
using PersonAgent.Desktop.Models;
using PersonAgent.Desktop.Services;

namespace PersonAgent.Desktop.ViewModels;

public sealed class ConnectionViewModel
{
    public ConnectionViewModel(string key, SourceStatus status, string timezone)
    {
        Key = key;
        Label = DisplayText.ConnectionLabel(key);
        State = status.State;
        StateText = DisplayText.ConnectionStateLabel(status.State);
        Message = status.Message ?? "";
        UpdatedText = status.UpdatedAt is null ? "" : $"更新于 {DisplayText.DateAndTime(status.UpdatedAt, timezone)}";
    }

    public string Key { get; }
    public string Label { get; }
    public string State { get; }
    public string StateText { get; }
    public string Message { get; }
    public string UpdatedText { get; }
    public bool HasMessage => !string.IsNullOrWhiteSpace(Message);
    public bool IsAvailable => State == "available";
}

public sealed class SettingsViewModel : PageViewModelBase
{
    private readonly Func<LocalApiClient?> _clientProvider;
    private readonly Action _openDiagnostics;
    private string _timezone = "Asia/Shanghai";
    private string _vaultPath = "";
    private bool _briefingEnabled = true;
    private string _briefingTime = "07:30";
    private bool _digestEnabled = true;
    private string _digestTime = "22:30";
    private string _briefingLast = "";
    private string _briefingNext = "";
    private string _digestLast = "";
    private string _digestNext = "";
    private string _workerStatus = "后台任务状态未知";
    private string _serviceVersion = "";
    private bool _isSaving;
    private string _saveMessage = "";
    private bool _isSaveError;

    public SettingsViewModel(Func<LocalApiClient?> clientProvider, Action openDiagnostics)
    {
        _clientProvider = clientProvider;
        _openDiagnostics = openDiagnostics;
        RefreshCommand = new AsyncRelayCommand(() => LoadAsync(refresh: true));
        SaveCommand = new AsyncRelayCommand(SaveAsync);
        DiagnosticsCommand = new RelayCommand(_openDiagnostics);
    }

    public ObservableCollection<ConnectionViewModel> Connections { get; } = new();
    public ICommand RefreshCommand { get; }
    public ICommand SaveCommand { get; }
    public ICommand DiagnosticsCommand { get; }

    public string Timezone
    {
        get => _timezone;
        set => SetProperty(ref _timezone, value);
    }

    public string VaultPath
    {
        get => _vaultPath;
        set => SetProperty(ref _vaultPath, value);
    }

    public bool BriefingEnabled
    {
        get => _briefingEnabled;
        set => SetProperty(ref _briefingEnabled, value);
    }

    public string BriefingTime
    {
        get => _briefingTime;
        set => SetProperty(ref _briefingTime, value);
    }

    public bool DigestEnabled
    {
        get => _digestEnabled;
        set => SetProperty(ref _digestEnabled, value);
    }

    public string DigestTime
    {
        get => _digestTime;
        set => SetProperty(ref _digestTime, value);
    }

    public string BriefingLast
    {
        get => _briefingLast;
        private set => SetProperty(ref _briefingLast, value);
    }

    public string BriefingNext
    {
        get => _briefingNext;
        private set => SetProperty(ref _briefingNext, value);
    }

    public string DigestLast
    {
        get => _digestLast;
        private set => SetProperty(ref _digestLast, value);
    }

    public string DigestNext
    {
        get => _digestNext;
        private set => SetProperty(ref _digestNext, value);
    }

    public string WorkerStatus
    {
        get => _workerStatus;
        private set => SetProperty(ref _workerStatus, value);
    }

    public string ServiceVersion
    {
        get => _serviceVersion;
        private set => SetProperty(ref _serviceVersion, value);
    }

    public bool IsSaving
    {
        get => _isSaving;
        private set => SetProperty(ref _isSaving, value);
    }

    public string SaveMessage
    {
        get => _saveMessage;
        private set
        {
            if (SetProperty(ref _saveMessage, value)) OnPropertyChanged(nameof(HasSaveMessage));
        }
    }

    public bool HasSaveMessage => !string.IsNullOrWhiteSpace(SaveMessage);

    public bool IsSaveError
    {
        get => _isSaveError;
        private set => SetProperty(ref _isSaveError, value);
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
            var settingsResponse = await client.GetSettingsAsync();
            Apply(settingsResponse.Settings);
            try
            {
                var health = await client.GetHealthAsync();
                ServiceVersion = $"v{health.Service.Version}";
                WorkerStatus = health.Worker.State switch
                {
                    "running" => "后台任务运行中",
                    "stopped" => "后台任务未运行",
                    "not_installed" => "后台任务未安装",
                    _ => "后台任务状态未知",
                };
            }
            catch (Exception)
            {
                WorkerStatus = "后台任务状态未知";
            }
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
    }

    private async Task SaveAsync()
    {
        var client = _clientProvider();
        if (client is null || IsSaving) return;
        IsSaving = true;
        IsSaveError = false;
        SaveMessage = "";
        try
        {
            var response = await client.UpdateSettingsAsync(new
            {
                Timezone,
                KnowledgeVaultPath = VaultPath,
                Briefing = new { Enabled = BriefingEnabled, Time = BriefingTime },
                KnowledgeDigest = new { Enabled = DigestEnabled, Time = DigestTime },
            });
            Apply(response.Settings);
            SaveMessage = "设置已保存，后台调度已更新。";
        }
        catch (Exception error)
        {
            IsSaveError = true;
            SaveMessage = DescribeError(error);
            await LoadAsync(refresh: true);
        }
        finally
        {
            IsSaving = false;
        }
    }

    private void Apply(Settings settings)
    {
        Timezone = settings.Timezone;
        VaultPath = settings.KnowledgeVaultPath;
        BriefingEnabled = settings.Automations.Briefing.Enabled;
        BriefingTime = settings.Automations.Briefing.Time;
        DigestEnabled = settings.Automations.KnowledgeDigest.Enabled;
        DigestTime = settings.Automations.KnowledgeDigest.Time;
        BriefingLast = LastText(settings.Automations.Briefing, settings.Timezone);
        BriefingNext = NextText(settings.Automations.Briefing, settings.Timezone);
        DigestLast = LastText(settings.Automations.KnowledgeDigest, settings.Timezone);
        DigestNext = NextText(settings.Automations.KnowledgeDigest, settings.Timezone);

        Connections.Clear();
        foreach (var (key, status) in settings.Connections)
        {
            Connections.Add(new ConnectionViewModel(key, status, settings.Timezone));
        }
    }

    private static string LastText(AutomationSetting setting, string timezone)
    {
        var result = DisplayText.LastResultLabel(setting.LastResult);
        return setting.LastRunAt is null
            ? $"上次：{result}"
            : $"上次：{result} · {DisplayText.DateAndTime(setting.LastRunAt, timezone)}";
    }

    private static string NextText(AutomationSetting setting, string timezone)
    {
        if (!setting.Enabled) return "已关闭";
        return setting.NextRunAt is null
            ? "下次运行：待计算"
            : $"下次运行：{DisplayText.DateAndTime(setting.NextRunAt, timezone)}";
    }
}
