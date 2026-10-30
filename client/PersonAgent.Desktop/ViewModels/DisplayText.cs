using System.Globalization;

namespace PersonAgent.Desktop.ViewModels;

public static class DisplayText
{
    private static readonly string[] Weekdays =
    {
        "星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六",
    };

    public static string DateHeader(string dateKey)
    {
        if (!DateOnly.TryParseExact(dateKey, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
        {
            return dateKey;
        }
        return $"{date.Year}年{date.Month}月{date.Day}日 {Weekdays[(int)date.DayOfWeek]}";
    }

    public static string Greeting(string timezone)
    {
        var hour = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, ResolveZone(timezone)).Hour;
        if (hour >= 5 && hour < 12) return "早上好";
        if (hour >= 12 && hour < 18) return "下午好";
        return "晚上好";
    }

    public static string Time(string? iso, string timezone)
    {
        var instant = Parse(iso);
        if (instant is null) return "未安排";
        return TimeZoneInfo.ConvertTime(instant.Value, ResolveZone(timezone))
            .ToString("HH:mm", CultureInfo.InvariantCulture);
    }

    public static string DateAndTime(string? iso, string timezone)
    {
        var instant = Parse(iso);
        if (instant is null) return "未安排";
        return TimeZoneInfo.ConvertTime(instant.Value, ResolveZone(timezone))
            .ToString("M月d日 HH:mm", CultureInfo.InvariantCulture);
    }

    public static string TimeRange(string? start, string? end, string timezone, bool allDay = false)
    {
        if (allDay) return "全天";
        var startText = Time(start, timezone);
        if (start is null) return startText;
        if (end is null) return startText;
        return $"{startText}–{Time(end, timezone)}";
    }

    public static string Updated(string? generatedAt, string dateKey, string timezone)
    {
        var instant = Parse(generatedAt);
        if (instant is null) return "尚未更新";
        var local = TimeZoneInfo.ConvertTime(instant.Value, ResolveZone(timezone));
        var localDate = local.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        return localDate == dateKey
            ? $"更新于 {local:HH:mm}"
            : $"更新于 {local:M月d日 HH:mm}";
    }

    public static string SourceLabel(string source) => source switch
    {
        "google" => "Google Calendar",
        "lecture" => "本地讲座",
        "task" => "已计划任务",
        "automation" => "自动任务",
        "approval" => "待审批",
        _ => source,
    };

    public static string TaskStatusLabel(string status) => status switch
    {
        "draft" => "草稿",
        "planned" => "已计划",
        "in_progress" => "进行中",
        "needs_replan" => "需重排",
        "completed" => "已完成",
        "cancelled" => "已取消",
        _ => status,
    };

    public static string EventStatusLabel(string status) => status switch
    {
        "confirmed" => "已确认",
        "tentative" => "待定",
        "cancelled" => "已取消",
        _ => status,
    };

    public static string JobStatusLabel(string status) => status switch
    {
        "scheduled" => "等待运行",
        "delivered" => "已运行",
        "failed" => "运行失败",
        "skipped" => "已跳过",
        "missed" => "未运行",
        "claimed" => "运行中",
        _ => status,
    };

    public static string ApprovalStatusLabel(string status) => status switch
    {
        "pending" => "待审批",
        "approved" => "已批准",
        "executing" => "执行中",
        "executed" => "已执行",
        "failed" => "执行失败",
        "rejected" => "已拒绝",
        _ => status,
    };

    public static string ReasonLabel(string reason) => reason switch
    {
        "in_progress" => "进行中",
        "planned_today" => "已安排",
        "due_today" => "今天截止",
        "overdue" => "已逾期",
        "high_priority" => "高优先级",
        "presentation_today" => "今天汇报",
        _ => reason,
    };

    public static string EvidenceLabel(string state) => state switch
    {
        "pending" => "待分析",
        "retrying" => "重试等待",
        "abstract_only" => "仅摘要",
        "fulltext" => "全文",
        "truncated_fulltext" => "头尾采样",
        _ => state,
    };

    public static string TaskKindLabel(string kind) => kind switch
    {
        "research" => "科研",
        "assignment" => "作业",
        "other" => "其他",
        _ => kind,
    };

    public static string PriorityLabel(string priority) => priority switch
    {
        "low" => "低优先级",
        "medium" => "中优先级",
        "high" => "高优先级",
        _ => priority,
    };

    public static string SourceTypeLabel(string source) => source switch
    {
        "manual" => "手动录入",
        "email" => "邮件",
        _ => source,
    };

    public static string OperationStatusLabel(string status) => status switch
    {
        "queued" => "排队中",
        "running" => "运行中",
        "succeeded" => "已完成",
        "failed" => "失败",
        _ => status,
    };

    public static string OperationStageLabel(string? stage) => stage switch
    {
        "syncing" => "同步 Zotero",
        "analyzing" => "分析论文",
        "writing" => "写入日报",
        "digesting" => "整理中",
        null => "",
        _ => stage,
    };

    public static string LastResultLabel(string? result) => result switch
    {
        "delivered" => "成功",
        "failed" => "失败",
        "skipped" => "已跳过",
        null => "尚无记录",
        _ => result,
    };

    public static string ConnectionLabel(string key) => key switch
    {
        "database" => "本地数据库",
        "vault" => "Obsidian 知识库",
        "zotero" => "Zotero",
        "googleCalendar" => "Google Calendar",
        "gmail" => "Gmail（只读）",
        "deepSeek" => "DeepSeek",
        "weather" => "天气",
        _ => key,
    };

    public static string ConnectionStateLabel(string state) => state switch
    {
        "available" => "可用",
        "unavailable" => "不可用",
        "not_configured" => "未配置",
        "unknown" => "未知",
        _ => state,
    };

    public static string SearchTypeLabel(string type) => type switch
    {
        "paper" => "论文",
        "task" => "任务",
        "idea" => "Idea",
        "lecture" => "讲座",
        _ => type,
    };

    public static string CreatorsText(IReadOnlyList<string> creators)
    {
        if (creators.Count == 0) return "作者未知";
        if (creators.Count <= 3) return string.Join("、", creators);
        return $"{string.Join("、", creators.Take(3))} 等";
    }

    public static string WeatherText(double? temperature, string condition)
    {
        if (temperature is null) return string.IsNullOrWhiteSpace(condition) ? "天气暂不可用" : condition;
        return $"{condition} {temperature.Value:0.#}°C";
    }

    private static TimeZoneInfo ResolveZone(string timezone)
    {
        if (string.IsNullOrWhiteSpace(timezone)) return TimeZoneInfo.Local;
        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById(timezone);
        }
        catch (TimeZoneNotFoundException)
        {
            return TimeZoneInfo.Local;
        }
        catch (InvalidTimeZoneException)
        {
            return TimeZoneInfo.Local;
        }
    }

    private static DateTimeOffset? Parse(string? iso)
    {
        if (string.IsNullOrWhiteSpace(iso)) return null;
        return DateTimeOffset.TryParse(
            iso,
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
            out var value)
            ? value
            : null;
    }
}
