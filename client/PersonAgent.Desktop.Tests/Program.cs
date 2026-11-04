using System.IO;
using System.Text.Json;
using PersonAgent.Desktop.Models;
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

Check("Conversation transcript JSON maps to persisted messages", () =>
{
    const string json = """
        {
          "conversation": {
            "id": "conv-1",
            "title": "帮我安排今天的阅读",
            "status": "active",
            "createdAt": "2026-11-04T02:00:00.000Z",
            "updatedAt": "2026-11-04T02:05:00.000Z",
            "lastMessageAt": "2026-11-04T02:05:00.000Z",
            "messageCount": 2
          },
          "messages": [
            { "id": "m1", "sequence": 1, "role": "user", "text": "帮我安排今天的阅读", "createdAt": "2026-11-04T02:00:00.000Z" },
            { "id": "m2", "sequence": 2, "role": "assistant", "text": "先看两篇论文。", "createdAt": "2026-11-04T02:00:10.000Z" }
          ],
          "requestId": "r1",
          "generatedAt": "2026-11-04T02:05:00.000Z"
        }
        """;
    var options = new JsonSerializerOptions
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };
    var parsed = JsonSerializer.Deserialize<ConversationMessagesResponse>(json, options);
    if (parsed is null) throw new InvalidOperationException("transcript did not deserialize");
    Equal("conv-1", parsed.Conversation.Id, "conversation id");
    Equal("帮我安排今天的阅读", parsed.Conversation.Title, "conversation title");
    Equal(2, parsed.Conversation.MessageCount, "message count");
    Equal(2, parsed.Messages.Count, "message rows");
    Equal("user", parsed.Messages[0].Role, "first role");
    Equal(2, parsed.Messages[1].Sequence, "second sequence");
    Equal("先看两篇论文。", parsed.Messages[1].Text, "assistant text");
});

Check("Agent message response carries the continued conversation id and new rows", () =>
{
    const string json = """
        {
          "conversationId": "conv-1",
          "answer": "第二轮回答",
          "references": [],
          "conversation": { "id": "conv-1", "title": "测试", "status": "active", "createdAt": "", "updatedAt": "", "lastMessageAt": null, "messageCount": 4 },
          "messages": [
            { "id": "m3", "sequence": 3, "role": "user", "text": "继续", "createdAt": "" },
            { "id": "m4", "sequence": 4, "role": "assistant", "text": "第二轮回答", "createdAt": "" }
          ]
        }
        """;
    var options = new JsonSerializerOptions
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };
    var parsed = JsonSerializer.Deserialize<AgentMessageResponse>(json, options);
    if (parsed is null) throw new InvalidOperationException("agent response did not deserialize");
    Equal("conv-1", parsed.ConversationId, "conversation id");
    Equal(4, parsed.Conversation.MessageCount, "message count");
    Equal(2, parsed.Messages.Count, "new rows");
    Equal("继续", parsed.Messages[0].Text, "user row");
    Equal("第二轮回答", parsed.Answer, "answer");
});

Check("Memory JSON maps to the settings view model fields", () =>
{
    const string json = """
        {
          "items": [
            {
              "id": "memory-1",
              "kind": "preference",
              "content": "偏好上午阅读论文",
              "sourceType": "explicit_user",
              "sourceId": null,
              "confidence": 1,
              "importance": 5,
              "validUntil": null,
              "createdAt": "2026-11-04T02:00:00.000Z",
              "updatedAt": "2026-11-04T02:00:00.000Z"
            }
          ]
        }
        """;
    var options = new JsonSerializerOptions
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };
    var parsed = JsonSerializer.Deserialize<MemoryListResponse>(json, options);
    if (parsed is null || parsed.Items.Count != 1) throw new InvalidOperationException("memory list did not deserialize");
    Equal("memory-1", parsed.Items[0].Id, "memory id");
    Equal("preference", parsed.Items[0].Kind, "memory kind");
    Equal(5, parsed.Items[0].Importance, "importance");
    Equal("explicit_user", parsed.Items[0].SourceType, "source type");
});

if (failures.Count > 0)
{
    Console.Error.WriteLine($"{failures.Count} desktop contract test(s) failed:");
    foreach (var failure in failures) Console.Error.WriteLine($"- {failure}");
    return 1;
}

Console.WriteLine($"{passed} desktop contract tests passed.");
return 0;
