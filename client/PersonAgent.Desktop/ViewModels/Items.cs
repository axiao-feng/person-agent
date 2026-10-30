using PersonAgent.Desktop.Models;

namespace PersonAgent.Desktop.ViewModels;

public sealed class NavItemViewModel
{
    public NavItemViewModel(string title, object page)
    {
        Title = title;
        Page = page;
    }

    public string Title { get; }
    public object Page { get; }
}


public sealed class FocusItemViewModel
{
    public FocusItemViewModel(FocusItem item, string timezone)
    {
        Item = item;
        TimeText = item.StartAt is not null
            ? DisplayText.TimeRange(item.StartAt, item.EndAt, timezone)
            : item.Deadline is not null
                ? $"截止 {DisplayText.DateAndTime(item.Deadline, timezone)}"
                : "未安排时间";
    }

    public FocusItem Item { get; }
    public string Title => Item.Title;
    public string TypeLabel => Item.Type == "lecture" ? "讲座" : "任务";
    public string ReasonText => DisplayText.ReasonLabel(Item.ReasonCode);
    public string TimeText { get; }
}

public sealed class TimelineItemViewModel
{
    public TimelineItemViewModel(TimelineItem item, string timezone)
    {
        Item = item;
        TimeText = item.AllDay ? "全天" : DisplayText.TimeRange(item.StartAt, item.EndAt, timezone);
        SourceText = DisplayText.SourceLabel(item.Source);
    }

    public TimelineItem Item { get; }
    public string Title => Item.Title;
    public string SourceKey => Item.Source;
    public string SourceText { get; }
    public string TimeText { get; }
    public string? DetailText => Item.Detail;
    public bool HasDetail => !string.IsNullOrWhiteSpace(Item.Detail);
    public string StatusText => Item.Source switch
    {
        "task" => DisplayText.TaskStatusLabel(Item.Status),
        "google" => DisplayText.EventStatusLabel(Item.Status),
        "automation" => DisplayText.JobStatusLabel(Item.Status),
        "approval" => DisplayText.ApprovalStatusLabel(Item.Status),
        "lecture" => Item.Status == "active" ? "有效" : Item.Status,
        _ => Item.Status,
    };
}

public sealed class KnowledgeItemViewModel
{
    public KnowledgeItemViewModel(PaperSummary paper)
    {
        Paper = paper;
    }

    public PaperSummary Paper { get; }
    public string Title => string.IsNullOrWhiteSpace(Paper.Title) ? "无标题" : Paper.Title;
    public string CreatorsText => DisplayText.CreatorsText(Paper.Creators);
    public string DateText => Paper.DateText ?? "日期未知";
    public string EvidenceKey => Paper.EvidenceState;
    public string EvidenceText => DisplayText.EvidenceLabel(Paper.EvidenceState);
    public string TagsText => string.Join(" · ", Paper.Tags.Take(3));
    public bool HasTags => Paper.Tags.Count > 0;
}

public sealed class ApprovalViewModel
{
    public ApprovalViewModel(Approval approval, string timezone)
    {
        Approval = approval;
        ProposedText = DisplayText.TimeRange(
            approval.Display.ProposedStart,
            approval.Display.ProposedEnd,
            timezone);
        OriginalText = approval.Display.OriginalStart is null
            ? "无（新建日程）"
            : DisplayText.TimeRange(
                approval.Display.OriginalStart,
                approval.Display.OriginalEnd,
                timezone);
        CreatedText = DisplayText.DateAndTime(approval.CreatedAt, timezone);
    }

    public Approval Approval { get; }
    public string Title => Approval.Display.Title;
    public string Target => Approval.Display.Target;
    public string ProposedText { get; }
    public string OriginalText { get; }
    public string CreatedText { get; }
    public string? ReasonText => Approval.Display.Reason;
    public bool HasReason => !string.IsNullOrWhiteSpace(Approval.Display.Reason);
    public string StatusText => DisplayText.ApprovalStatusLabel(Approval.Status);
}

public sealed class DetailRow
{
    public DetailRow(string label, string value)
    {
        Label = label;
        Value = value;
    }

    public string Label { get; }
    public string Value { get; }
}

public sealed class DetailViewModel
{
    public DetailViewModel(
        string title,
        string kindText,
        string statusText,
        IReadOnlyList<DetailRow> rows,
        string? note = null,
        bool isApproval = false,
        string? objectId = null)
    {
        Title = title;
        KindText = kindText;
        StatusText = statusText;
        Rows = rows;
        Note = note;
        IsApproval = isApproval;
        ObjectId = objectId;
    }

    public string Title { get; }
    public string KindText { get; }
    public string StatusText { get; }
    public IReadOnlyList<DetailRow> Rows { get; }
    public string? Note { get; }
    public bool HasNote => !string.IsNullOrWhiteSpace(Note);
    public bool IsApproval { get; }
    public string? ObjectId { get; }

    public static DetailViewModel FromFocus(FocusItemViewModel focus, string timezone)
    {
        var rows = new List<DetailRow>
        {
            new("类型", focus.TypeLabel),
            new("时间", focus.TimeText),
        };
        if (focus.Item.Deadline is not null)
        {
            rows.Add(new DetailRow("截止", DisplayText.DateAndTime(focus.Item.Deadline, timezone)));
        }
        rows.Add(new DetailRow("标识", focus.Item.Id));
        return new DetailViewModel(
            focus.Title,
            "今日重点",
            focus.ReasonText,
            rows,
            objectId: focus.Item.Id);
    }

    public static DetailViewModel FromTimeline(TimelineItemViewModel timeline, string timezone)
    {
        var rows = new List<DetailRow>
        {
            new("来源", timeline.SourceText),
            new("开始", timeline.TimeText),
            new("状态", timeline.StatusText),
        };
        if (timeline.Item.EndAt is not null)
        {
            rows.Add(new DetailRow("结束", DisplayText.Time(timeline.Item.EndAt, timezone)));
        }
        if (!string.IsNullOrWhiteSpace(timeline.Item.Detail))
        {
            rows.Add(new DetailRow("详情", timeline.Item.Detail));
        }
        if (!string.IsNullOrWhiteSpace(timeline.Item.LinkedObjectId))
        {
            rows.Add(new DetailRow("关联对象", timeline.Item.LinkedObjectId));
        }
        return new DetailViewModel(
            timeline.Title,
            timeline.SourceText,
            timeline.StatusText,
            rows,
            objectId: timeline.Item.Id);
    }

    public static DetailViewModel FromPaper(KnowledgeItemViewModel paper)
    {
        var rows = new List<DetailRow>
        {
            new("作者", paper.CreatorsText),
            new("日期", paper.DateText),
            new("证据", paper.EvidenceText),
        };
        if (paper.HasTags)
        {
            rows.Add(new DetailRow("标签", paper.TagsText));
        }
        rows.Add(new DetailRow("标识", paper.Paper.Key));
        return new DetailViewModel(
            paper.Title,
            "论文",
            paper.EvidenceText,
            rows,
            objectId: paper.Paper.Key);
    }

    public static DetailViewModel FromApproval(ApprovalViewModel approval)
    {
        var rows = new List<DetailRow>
        {
            new("外部目标", approval.Target),
            new("原时间", approval.OriginalText),
            new("建议时间", approval.ProposedText),
        };
        if (approval.HasReason)
        {
            rows.Add(new DetailRow("变更原因", approval.ReasonText!));
        }
        rows.Add(new DetailRow("创建时间", approval.CreatedText));
        rows.Add(new DetailRow("操作 ID", approval.Approval.Id));
        return new DetailViewModel(
            approval.Title,
            "待审批操作",
            approval.StatusText,
            rows,
            "尚未写入 Google Calendar。确认后才会创建或修改外部日程。",
            isApproval: true,
            objectId: approval.Approval.Id);
    }
}
