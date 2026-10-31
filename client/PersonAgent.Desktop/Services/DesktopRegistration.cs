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
    public static void Register()
    {
        var executable = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(executable) || !File.Exists(executable)) return;
        var folder = AppHome();
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
