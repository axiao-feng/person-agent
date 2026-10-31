namespace PersonAgent.Desktop.Services;

public enum DeepLinkKind
{
    Activate,
    Today,
    Approval,
    Lecture,
}

/// <summary>
/// A command forwarded by a Windows notification or a second client launch.
/// The same link travels over the single-instance named pipe as a short string.
/// </summary>
public sealed record DeepLink(DeepLinkKind Kind, string? ObjectId)
{
    public static DeepLink Activate { get; } = new(DeepLinkKind.Activate, null);

    public static DeepLink? Parse(IReadOnlyList<string> args)
    {
        for (var index = 0; index < args.Count; index += 1)
        {
            var argument = args[index];
            if (argument.Equals("--today", StringComparison.OrdinalIgnoreCase))
            {
                return new DeepLink(DeepLinkKind.Today, null);
            }
            if (argument.Equals("--activate", StringComparison.OrdinalIgnoreCase))
            {
                return Activate;
            }
            if (argument.Equals("--approval", StringComparison.OrdinalIgnoreCase) &&
                TryNext(args, ref index, out var approvalId))
            {
                return new DeepLink(DeepLinkKind.Approval, approvalId);
            }
            if (argument.Equals("--lecture", StringComparison.OrdinalIgnoreCase) &&
                TryNext(args, ref index, out var lectureId))
            {
                return new DeepLink(DeepLinkKind.Lecture, lectureId);
            }
            if (argument.StartsWith("person-agent://", StringComparison.OrdinalIgnoreCase) &&
                TryParseUri(argument, out var uriLink))
            {
                return uriLink;
            }
        }
        return null;
    }

    public string Serialize() =>
        Kind switch
        {
            DeepLinkKind.Approval => $"approval|{ObjectId}",
            DeepLinkKind.Lecture => $"lecture|{ObjectId}",
            DeepLinkKind.Today => "today|",
            _ => "activate|",
        };

    public static DeepLink? Deserialize(string payload)
    {
        var separator = payload.IndexOf('|');
        var kind = (separator >= 0 ? payload[..separator] : payload).Trim().ToLowerInvariant();
        var objectId = separator >= 0 ? payload[(separator + 1)..].Trim() : "";
        return kind switch
        {
            "activate" => Activate,
            "today" => new DeepLink(DeepLinkKind.Today, null),
            "approval" when objectId.Length > 0 => new DeepLink(DeepLinkKind.Approval, objectId),
            "lecture" when objectId.Length > 0 => new DeepLink(DeepLinkKind.Lecture, objectId),
            _ => null,
        };
    }

    private static bool TryNext(IReadOnlyList<string> args, ref int index, out string value)
    {
        if (index + 1 < args.Count && !string.IsNullOrWhiteSpace(args[index + 1]))
        {
            index += 1;
            value = args[index];
            return true;
        }
        value = "";
        return false;
    }

    private static bool TryParseUri(string argument, out DeepLink? link)
    {
        link = null;
        if (!Uri.TryCreate(argument, UriKind.Absolute, out var uri) ||
            !uri.Scheme.Equals("person-agent", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }
        var target = uri.Host.ToLowerInvariant();
        var objectId = uri.AbsolutePath.Trim('/');
        if (!string.IsNullOrWhiteSpace(objectId))
        {
            objectId = Uri.UnescapeDataString(objectId);
        }
        link = target switch
        {
            "today" => new DeepLink(DeepLinkKind.Today, null),
            "approval" when objectId.Length > 0 => new DeepLink(DeepLinkKind.Approval, objectId),
            "lecture" when objectId.Length > 0 => new DeepLink(DeepLinkKind.Lecture, objectId),
            "activate" => Activate,
            _ => null,
        };
        return link is not null;
    }
}
