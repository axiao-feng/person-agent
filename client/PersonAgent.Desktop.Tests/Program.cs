using System.IO;
using System.Text.Json;
using PersonAgent.Desktop.Services;

var passed = 0;
var failures = new List<string>();

void Check(string name, Action test)
{
    try
    {
        test();
        passed += 1;
        Console.WriteLine($"PASS {name}");
    }
    catch (Exception error)
    {
        failures.Add($"{name}: {error.Message}");
        Console.WriteLine($"FAIL {name}: {error.Message}");
    }
}

static void Equal<T>(T expected, T actual, string label)
{
    if (!EqualityComparer<T>.Default.Equals(expected, actual))
    {
        throw new InvalidOperationException($"{label}: expected '{expected}', got '{actual}'");
    }
}

Check("DeepLink parses an approval argument", () =>
{
    var link = DeepLink.Parse(new[] { "--approval", "approval-1" });
    if (link is null) throw new InvalidOperationException("link was null");
    Equal(DeepLinkKind.Approval, link.Kind, "kind");
    Equal("approval-1", link.ObjectId, "object id");
});

Check("DeepLink parses today, lecture, and protocol URIs", () =>
{
    Equal(DeepLinkKind.Today, DeepLink.Parse(new[] { "--today" })!.Kind, "today");
    var lecture = DeepLink.Parse(new[] { "--lecture", "lecture-1" });
    Equal(DeepLinkKind.Lecture, lecture!.Kind, "lecture kind");
    Equal("lecture-1", lecture.ObjectId, "lecture id");
    var uri = DeepLink.Parse(new[] { "person-agent://approval/approval%202" });
    Equal(DeepLinkKind.Approval, uri!.Kind, "uri kind");
    Equal("approval 2", uri.ObjectId, "uri id");
});

Check("DeepLink round-trips through the single-instance payload", () =>
{
    var original = new DeepLink(DeepLinkKind.Approval, "approval-42");
    var restored = DeepLink.Deserialize(original.Serialize());
    Equal(DeepLinkKind.Approval, restored!.Kind, "kind");
    Equal("approval-42", restored.ObjectId, "object id");
    Equal(null, DeepLink.Deserialize("unknown|value"), "unknown payload");
});

Check("Desktop registration writes executable metadata to an explicit home", () =>
{
    var folder = Path.Combine(
        Path.GetTempPath(),
        $"person-agent-desktop-test-{Guid.NewGuid():N}");
    try
    {
        var path = DesktopRegistration.Register(folder);
        if (!File.Exists(path))
        {
            throw new InvalidOperationException("desktop.json was not created");
        }
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        var executable = document.RootElement.GetProperty("executable").GetString();
        if (string.IsNullOrWhiteSpace(executable) || !File.Exists(executable))
        {
            throw new InvalidOperationException("registered executable is missing");
        }
    }
    finally
    {
        if (Directory.Exists(folder)) Directory.Delete(folder, recursive: true);
    }
});

if (failures.Count > 0)
{
    Console.Error.WriteLine($"{failures.Count} desktop contract test(s) failed:");
    foreach (var failure in failures) Console.Error.WriteLine($"- {failure}");
    return 1;
}

Console.WriteLine($"{passed} desktop contract tests passed.");
return 0;
