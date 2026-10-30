using System.Globalization;

namespace PersonAgent.Desktop.ViewModels;

public static class TimeZoneMath
{
    private static readonly string[] Weekdays =
    {
        "周日", "周一", "周二", "周三", "周四", "周五", "周六",
    };

    public static TimeZoneInfo Resolve(string timezone)
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

    public static DateOnly Today(string timezone) =>
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, Resolve(timezone)).DateTime);

    public static DateOnly WeekStart(DateOnly date)
    {
        var offset = ((int)date.DayOfWeek + 6) % 7;
        return date.AddDays(-offset);
    }

    public static string DayTitle(DateOnly date) =>
        $"{date.Month}月{date.Day}日 {Weekdays[(int)date.DayOfWeek]}";

    public static string DayTitleWithYear(DateOnly date) =>
        $"{date.Year}年{date.Month}月{date.Day}日 {Weekdays[(int)date.DayOfWeek]}";

    public static bool IsToday(DateOnly date, string timezone) => date == Today(timezone);

    public static DateTimeOffset LocalStart(DateOnly date, string timezone) =>
        LocalDateTime(date, TimeSpan.Zero, timezone);

    public static DateTimeOffset LocalEnd(DateOnly date, string timezone) =>
        LocalDateTime(date, new TimeSpan(23, 59, 59), timezone);

    public static DateTimeOffset LocalDateTime(DateOnly date, TimeSpan time, string timezone)
    {
        var zone = Resolve(timezone);
        var unspecified = DateTime.SpecifyKind(
            date.ToDateTime(TimeOnly.FromTimeSpan(time)),
            DateTimeKind.Unspecified);
        var offset = zone.GetUtcOffset(unspecified);
        return new DateTimeOffset(unspecified, offset);
    }

    public static DateOnly ToLocalDate(string iso, string timezone)
    {
        var instant = Parse(iso);
        return DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(instant, Resolve(timezone)).DateTime);
    }

    public static string ToLocalTime(string iso, string timezone)
    {
        var instant = Parse(iso);
        return TimeZoneInfo.ConvertTime(instant, Resolve(timezone))
            .ToString("HH:mm", CultureInfo.InvariantCulture);
    }

    public static string ToLocalDateText(string iso, string timezone)
    {
        var instant = Parse(iso);
        return TimeZoneInfo.ConvertTime(instant, Resolve(timezone))
            .ToString("M月d日 HH:mm", CultureInfo.InvariantCulture);
    }

    public static DateTimeOffset Parse(string iso) =>
        DateTimeOffset.TryParse(
            iso,
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
            out var value)
            ? value
            : DateTimeOffset.UtcNow;
}
