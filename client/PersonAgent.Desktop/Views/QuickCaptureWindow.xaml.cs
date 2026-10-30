using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using PersonAgent.Desktop.Services;
using PersonAgent.Desktop.ViewModels;

namespace PersonAgent.Desktop.Views;

public partial class QuickCaptureWindow : Window
{
    private readonly LocalApiClient _client;
    private readonly string _timezone;
    private bool _saving;

    public QuickCaptureWindow(LocalApiClient client, string timezone, string initialType)
    {
        InitializeComponent();
        _client = client;
        _timezone = timezone;
        CaptureTabs.SelectedIndex = initialType switch
        {
            "task" => 1,
            "lecture" => 2,
            _ => 0,
        };
        TaskKindComboBox.SelectedIndex = 0;
        TaskPriorityComboBox.SelectedIndex = 1;
        TaskMinutesTextBox.Text = "60";
        var nextHour = DateTime.Now.AddHours(1);
        LectureStartDatePicker.SelectedDate = nextHour.Date;
        LectureStartTimeTextBox.Text = nextHour.ToString("HH:00", CultureInfo.InvariantCulture);
    }

    private async void Save_Click(object sender, RoutedEventArgs e)
    {
        if (_saving) return;
        _saving = true;
        SaveButton.IsEnabled = false;
        ErrorText.Visibility = Visibility.Collapsed;
        try
        {
            switch (CaptureTabs.SelectedIndex)
            {
                case 0:
                    await SaveIdeaAsync();
                    break;
                case 1:
                    await SaveTaskAsync();
                    break;
                case 2:
                    await SaveLectureAsync();
                    break;
            }
            DialogResult = true;
            Close();
        }
        catch (Exception error)
        {
            ShowError(error.Message);
        }
        finally
        {
            _saving = false;
            SaveButton.IsEnabled = true;
        }
    }

    private async Task SaveIdeaAsync()
    {
        var body = IdeaBodyTextBox.Text;
        if (string.IsNullOrWhiteSpace(body))
        {
            throw new InvalidOperationException("请填写 idea 正文。");
        }
        var title = string.IsNullOrWhiteSpace(IdeaTitleTextBox.Text) ? null : IdeaTitleTextBox.Text.Trim();
        var tags = IdeaTagsTextBox.Text
            .Split(new[] { ',', '，' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(tag => !string.IsNullOrWhiteSpace(tag))
            .ToList();
        await _client.CreateIdeaAsync(body, title, tags);
    }

    private async Task SaveTaskAsync()
    {
        var title = TaskTitleTextBox.Text.Trim();
        if (string.IsNullOrEmpty(title)) throw new InvalidOperationException("请填写任务标题。");
        if (!int.TryParse(TaskMinutesTextBox.Text.Trim(), out var minutes) || minutes < 5 || minutes > 1440)
        {
            throw new InvalidOperationException("预计耗时必须是 5 到 1440 的整数。");
        }
        var deadline = BuildInstant(TaskDeadlineDatePicker, TaskDeadlineTimeTextBox, "18:00", required: false);
        var kind = TaskKindComboBox.SelectedIndex switch
        {
            1 => "assignment",
            2 => "other",
            _ => "research",
        };
        var priority = TaskPriorityComboBox.SelectedIndex switch
        {
            0 => "low",
            2 => "high",
            _ => "medium",
        };
        await _client.CreateTaskAsync(title, kind, minutes, deadline, priority);
    }

    private async Task SaveLectureAsync()
    {
        var title = LectureTitleTextBox.Text.Trim();
        if (string.IsNullOrEmpty(title)) throw new InvalidOperationException("请填写讲座标题。");
        var start = BuildInstant(LectureStartDatePicker, LectureStartTimeTextBox, "18:00", required: true);
        var end = BuildInstant(LectureEndDatePicker, LectureEndTimeTextBox, "18:00", required: false);
        if (start is not null && end is not null &&
            DateTimeOffset.Parse(end, CultureInfo.InvariantCulture) <=
            DateTimeOffset.Parse(start, CultureInfo.InvariantCulture))
        {
            throw new InvalidOperationException("讲座结束时间必须晚于开始时间。");
        }
        await _client.CreateLectureAsync(
            title,
            start!,
            end,
            NullIfBlank(LectureLocationTextBox.Text),
            NullIfBlank(LectureSpeakerTextBox.Text),
            NullIfBlank(LectureNotesTextBox.Text),
            RequiresPresentationCheckBox.IsChecked == true);
    }

    private string? BuildInstant(DatePicker picker, TextBox timeBox, string defaultTime, bool required)
    {
        var dateValue = picker.SelectedDate;
        var timeText = timeBox.Text.Trim();
        if (dateValue is null)
        {
            if (required) throw new InvalidOperationException("请选择日期。");
            if (!string.IsNullOrWhiteSpace(timeText)) throw new InvalidOperationException("填写时间前请先选择日期。");
            return null;
        }
        if (string.IsNullOrWhiteSpace(timeText)) timeText = defaultTime;
        if (!TimeOnly.TryParseExact(
                timeText,
                new[] { "HH:mm", "H:mm" },
                CultureInfo.InvariantCulture,
                DateTimeStyles.None,
                out var time))
        {
            throw new InvalidOperationException($"时间格式无效：{timeText}，请使用 HH:mm。");
        }
        var date = DateOnly.FromDateTime(dateValue.Value);
        return TimeZoneMath.LocalDateTime(date, time.ToTimeSpan(), _timezone)
            .ToUniversalTime()
            .ToString("O", CultureInfo.InvariantCulture);
    }

    private static string? NullIfBlank(string value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private void ShowError(string message)
    {
        ErrorText.Text = message;
        ErrorText.Visibility = Visibility.Visible;
    }

    private void Cancel_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }
}
