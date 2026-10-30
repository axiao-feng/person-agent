using System.IO;
using System.Windows;
using System.Windows.Threading;
using PersonAgent.Desktop.ViewModels;

namespace PersonAgent.Desktop;

public partial class App : Application
{
    private MainViewModel? _viewModel;

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
            LogError(args.ExceptionObject as Exception ?? new Exception("未知未处理异常"));
        try
        {
            _viewModel = new MainViewModel();
            var window = new MainWindow { DataContext = _viewModel };
            MainWindow = window;
            window.Show();
            await _viewModel.InitializeAsync();
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
        _viewModel?.Dispose();
        base.OnExit(e);
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
