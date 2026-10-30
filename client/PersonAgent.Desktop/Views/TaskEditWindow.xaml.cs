using System.Globalization;
using System.Windows;
using PersonAgent.Desktop.Models;
using PersonAgent.Desktop.Services;
using PersonAgent.Desktop.ViewModels;

namespace PersonAgent.Desktop.Views;

public partial class TaskEditWindow : Window
{
    private readonly LocalApiClient _client;
    private readonly string _timezone;
    private readonly TaskItem _task;
    private bool _saving;

    public TaskEditWindow(LocalApiClient client, string timezone, TaskItem task)
    {
        InitializeComponent();
        _client = client;
        _timezone = timezone;
        _task = task;
        TitleTextBox.Text = task.Title;
        KindComboBox.SelectedIndex = task.TaskKind switch
        {
            "assignment" => 1,
            "other" => 2,
            _ => 0,
        };
        PriorityComboBox.SelectedIndex = task.Priority switch
        {
            "low" => 0,
            "high" => 2,
            _ => 1,
        };
        MinutesTextBox.Text = task.EstimatedMinutes.ToString(CultureInfo.InvariantCulture);
        if (task.Deadline is not null)
        {
            var localDate = TimeZoneMath.ToLocalDate(task.Deadline, timezone);
            DeadlineDatePicker.SelectedDate = localDate.ToDateTime(TimeOnly.MinValue);
            DeadlineTimeTextBox.Text = TimeZoneMath.ToLocalTime(task.Deadline, timezone);
        }
    }

    private async void Save_Click(object sender, RoutedEventArgs e)
    {
        if (_saving) return;
        _saving = true;
        SaveButton.IsEnabled = false;
        ErrorText.Visibility = Visibility.Collapsed;
        try
        {
            var title = TitleTextBox.Text.Trim();
            if (string.IsNullOrEmpty(title)) throw new InvalidOperationException("请填写任务标题。");
            if (!int.TryParse(MinutesTextBox.Text.Trim(), out var minutes) || minutes < 5 || minutes > 1440)
            {
                throw new InvalidOperationException("预计耗时必须是 5 到 1440 的整数。");
            }
            string? deadline = null;
            var clearDeadline = DeadlineDatePicker.SelectedDate is null;
            if (!clearDeadline)
            {
                var timeText = DeadlineTimeTextBox.Text.Trim();
                if (string.IsNullOrWhiteSpace(timeText)) timeText = "18:00";
                if (!TimeOnly.TryParseExact(
                        timeText,
                        new[] { "HH:mm", "H:mm" },
                        CultureInfo.InvariantCulture,
                        DateTimeStyles.None,
                        out var time))
                {
                    throw new InvalidOperationException($"时间格式无效：{timeText}，请使用 HH:mm。");
                }
                var date = DateOnly.FromDateTime(DeadlineDatePicker.SelectedDate!.Value);
                deadline = TimeZoneMath.LocalDateTime(date, time.ToTimeSpan(), _timezone)
                    .ToUniversalTime()
                    .ToString("O", CultureInfo.InvariantCulture);
            }
            var kind = KindComboBox.SelectedIndex switch
            {
                1 => "assignment",
                2 => "other",
                _ => "research",
            };
            var priority = PriorityComboBox.SelectedIndex switch
            {
                0 => "low",
                2 => "high",
                _ => "medium",
            };
            await _client.EditTaskAsync(_task.Id, title, kind, minutes, deadline, clearDeadline, priority);
            DialogResult = true;
            Close();
        }
        catch (Exception error)
        {
            ErrorText.Text = error.Message;
            ErrorText.Visibility = Visibility.Visible;
        }
        finally
        {
            _saving = false;
            SaveButton.IsEnabled = true;
        }
    }

    private void Cancel_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }
}
