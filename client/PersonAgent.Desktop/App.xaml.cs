using System.IO;
using System.Windows;
using System.Windows.Threading;
using PersonAgent.Desktop.Services;
using PersonAgent.Desktop.ViewModels;

namespace PersonAgent.Desktop;

public partial class App : Application
{
    private MainViewModel? _viewModel;
    private SingleInstance? _singleInstance;
    private DeepLink? _pendingLink;
    private bool _initialized;

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
            LogError(args.ExceptionObject as Exception ?? new Exception("未知未处理异常"));
        try
        {
            var startupLink = DeepLink.Parse(e.Args);
            _singleInstance = SingleInstance.Acquire();
            if (!_singleInstance.IsPrimary)
            {
                var forwarded = await SingleInstance.ForwardAsync(
                    (startupLink ?? DeepLink.Activate).Serialize(),
                    TimeSpan.FromSeconds(5));
                LogEvent($"single_instance_forwarded:{forwarded}");
                if (!forwarded)
                {
                    MessageBox.Show(
                        "Person Agent 已在运行，但无法激活现有窗口。请手动切换到已打开的窗口。",
                        "Person Agent",
                        MessageBoxButton.OK,
                        MessageBoxImage.Information);
                }
                Shutdown(forwarded ? 0 : 1);
                return;
            }

            _singleInstance.CommandReceived += OnCommandReceived;
            try
            {
                DesktopRegistration.Register();
                LogEvent("desktop_registered");
            }
            catch (Exception registrationError)
            {
                // Deep links are optional; the rest of the client must still start.
                LogError(registrationError);
            }

            _viewModel = new MainViewModel();
            var window = new MainWindow { DataContext = _viewModel };
            MainWindow = window;
            window.Show();
            await _viewModel.InitializeAsync();
            _initialized = true;

            if (startupLink is not null)
            {
                await OpenLinkSafelyAsync(startupLink);
            }
            if (_pendingLink is { } pending)
            {
                _pendingLink = null;
                await OpenLinkSafelyAsync(pending);
            }
        }
        catch (Exception error)
        {
            LogError(error);
            MessageBox.Show(
                $"Person Agent 启动失败：\n{error.Message}",
                "Person Agent",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            Shutdown(1);
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _singleInstance?.Dispose();
        _viewModel?.Dispose();
        base.OnExit(e);
    }

    private void OnCommandReceived(string payload)
    {
        LogEvent($"deep_link_received:{payload}");
        var link = DeepLink.Deserialize(payload);
        if (link is null) return;
        Dispatcher.InvokeAsync(async () =>
        {
            try
            {
                if (_viewModel is null || !_initialized)
                {
                    _pendingLink = link;
                    return;
                }
                await OpenLinkAsync(link);
                ActivateMainWindow();
            }
            catch (Exception error)
            {
                LogError(error);
            }
        });
    }

    private async Task OpenLinkAsync(DeepLink link)
    {
        if (_viewModel is null) return;
        LogEvent($"deep_link_opening:{link.Serialize()}");
        await _viewModel.OpenDeepLinkAsync(link);
    }

    private async Task OpenLinkSafelyAsync(DeepLink link)
    {
        try
        {
            await OpenLinkAsync(link);
        }
        catch (Exception error)
        {
            // A stale notification must not turn a healthy startup into a crash.
            LogError(error);
        }
    }

    private void ActivateMainWindow()
    {
        if (MainWindow is not { } window) return;
        if (window.WindowState == WindowState.Minimized)
        {
            window.WindowState = WindowState.Normal;
        }
        window.Show();
        window.Activate();
        window.Topmost = true;
        window.Topmost = false;
    }

    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        LogError(e.Exception);
        MessageBox.Show(
            $"Person Agent 遇到未处理的错误：\n{e.Exception.Message}",
            "Person Agent",
            MessageBoxButton.OK,
            MessageBoxImage.Error);
        e.Handled = true;
    }

    internal static void LogError(Exception exception)
    {
        try
        {
            var folder = LogFolder();
            Directory.CreateDirectory(folder);
            File.AppendAllText(
                Path.Combine(folder, "desktop-errors.log"),
                $"[{DateTimeOffset.Now:O}] {exception}\n\n");
        }
        catch
        {
            // Logging must never mask the original error.
        }
    }

    internal static void LogEvent(string message)
    {
        try
        {
            var folder = LogFolder();
            Directory.CreateDirectory(folder);
            File.AppendAllText(
                Path.Combine(folder, "desktop-events.log"),
                $"[{DateTimeOffset.Now:O}] {message}\n");
        }
        catch
        {
            // Diagnostics must never block the UI.
        }
    }

    private static string LogFolder() =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "person-agent");
}
