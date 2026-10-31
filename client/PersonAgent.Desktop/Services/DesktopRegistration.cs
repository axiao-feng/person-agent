using System.IO;
using System.Reflection;
using System.Text.Json;

namespace PersonAgent.Desktop.Services;

/// <summary>
/// Publishes the client executable so the worker's Windows notification can
/// offer a deep link into the exact approval, lecture, or today page.
/// </summary>
public static class DesktopRegistration
{
    /// <summary>
    /// Writes the registration into the supplied app home, or the environment
    /// default. The backend's ready message is authoritative because it has
    /// already loaded the repository .env; writing both locations keeps deep
    /// links working when the worker and client were started differently.
    /// </summary>
    public static string Register(string? home = null)
    {
        var executable = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(executable) || !File.Exists(executable))
        {
            throw new InvalidOperationException("找不到当前客户端可执行文件，无法登记通知深链。");
        }
        var folder = string.IsNullOrWhiteSpace(home) ? AppHome() : home.Trim();
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, "desktop.json");
        var temporary = $"{path}.{Environment.ProcessId}.tmp";
        var payload = new
        {
            executable,
            version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "",
            registeredAt = DateTimeOffset.Now.ToString("O"),
        };
        File.WriteAllText(temporary, JsonSerializer.Serialize(payload));
        File.Move(temporary, path, overwrite: true);
        return path;
    }

    public static string AppHome()
    {
        var configured = Environment.GetEnvironmentVariable("PERSON_AGENT_HOME");
        return !string.IsNullOrWhiteSpace(configured)
            ? configured
            : Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "person-agent");
    }
}
