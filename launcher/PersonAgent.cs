using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace PersonAgentLauncher
{
    internal sealed class LauncherConfig
    {
        public string NodePath;
        public string CliPath;

        public static LauncherConfig Load()
        {
            string baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
            string path = Path.Combine(baseDirectory, "launcher.ini");
            if (!File.Exists(path))
            {
                throw new InvalidOperationException("找不到 launcher.ini，请重新运行 person-agent launcher install。");
            }
            string node = null;
            string cli = null;
            foreach (string raw in File.ReadAllLines(path, Encoding.UTF8))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line.StartsWith(";") || line.StartsWith("#")) continue;
                int index = line.IndexOf('=');
                if (index <= 0) continue;
                string key = line.Substring(0, index).Trim();
                string value = line.Substring(index + 1).Trim();
                if (string.Equals(key, "node", StringComparison.OrdinalIgnoreCase)) node = value;
                else if (string.Equals(key, "cli", StringComparison.OrdinalIgnoreCase)) cli = value;
            }
            if (string.IsNullOrEmpty(node) || string.IsNullOrEmpty(cli))
            {
                throw new InvalidOperationException("launcher.ini 缺少 node 或 cli 配置，请重新运行 person-agent launcher install。");
            }
            if (!File.Exists(node)) throw new InvalidOperationException("找不到 Node.js：" + node);
            if (!File.Exists(cli)) throw new InvalidOperationException("找不到 CLI：" + cli + "，请先运行 pnpm build。");
            LauncherConfig config = new LauncherConfig();
            config.NodePath = node;
            config.CliPath = cli;
            return config;
        }
    }

    internal sealed class CliResult
    {
        public int ExitCode;
        public string Stdout;
        public string Stderr;
    }

    internal sealed class PersonAgentForm : Form
    {
        private readonly LauncherConfig _config;
        private readonly List<Button> _buttons = new List<Button>();

        private TabControl _tabs;
        private TabPage _ideaPage;
        private TabPage _assignmentPage;
        private TabPage _lecturePage;

        private TextBox _ideaTitle;
        private TextBox _ideaTags;
        private TextBox _ideaBody;

        private TextBox _assignmentTitle;
        private CheckBox _deadlineEnabled;
        private DateTimePicker _deadline;
        private NumericUpDown _minutes;
        private ComboBox _priority;

        private TextBox _lectureTitle;
        private DateTimePicker _lectureStart;
        private CheckBox _endEnabled;
        private DateTimePicker _lectureEnd;
        private TextBox _lectureLocation;
        private TextBox _lectureSpeaker;
        private TextBox _lectureNotes;
        private CheckBox _requiresPresentation;

        private Label _status;

        public PersonAgentForm(LauncherConfig config)
        {
            _config = config;
            Text = "Person Agent 知识录入";
            Width = 720;
            Height = 640;
            MinimumSize = new Size(660, 540);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Microsoft YaHei UI", 10F);
            AutoScaleMode = AutoScaleMode.Dpi;

            TableLayoutPanel layout = new TableLayoutPanel();
            layout.Dock = DockStyle.Fill;
            layout.ColumnCount = 1;
            layout.RowCount = 3;
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 28F));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 52F));

            _tabs = new TabControl();
            _tabs.Dock = DockStyle.Fill;
            _ideaPage = new TabPage("Idea");
            _assignmentPage = new TabPage("作业");
            _lecturePage = new TabPage("讲座");
            _ideaPage.AutoScroll = true;
            _assignmentPage.AutoScroll = true;
            _lecturePage.AutoScroll = true;
            _tabs.TabPages.Add(_ideaPage);
            _tabs.TabPages.Add(_assignmentPage);
            _tabs.TabPages.Add(_lecturePage);
            BuildIdeaPage();
            BuildAssignmentPage();
            BuildLecturePage();

            _status = new Label();
            _status.Dock = DockStyle.Fill;
            _status.TextAlign = ContentAlignment.MiddleLeft;
            _status.Padding = new Padding(12, 0, 0, 0);
            _status.Text = "填写后点击保存；作业和讲座不会自动写入 Calendar。";

            FlowLayoutPanel actions = new FlowLayoutPanel();
            actions.Dock = DockStyle.Fill;
            actions.FlowDirection = FlowDirection.RightToLeft;
            actions.WrapContents = false;
            actions.Padding = new Padding(8, 7, 8, 7);

            Button openToday = CreateButton("打开今日日报", OpenTodayClick);
            Button digest = CreateButton("立即整理", DigestClick);
            Button saveClose = CreateButton("保存并关闭", SaveAndCloseClick);
            Button save = CreateButton("保存", SaveClick);
            actions.Controls.Add(openToday);
            actions.Controls.Add(digest);
            actions.Controls.Add(saveClose);
            actions.Controls.Add(save);

            layout.Controls.Add(_tabs, 0, 0);
            layout.Controls.Add(_status, 0, 1);
            layout.Controls.Add(actions, 0, 2);
            Controls.Add(layout);
        }

        private void BuildIdeaPage()
        {
            AddLabel(_ideaPage, "标题（可空，默认取正文首行）", 16, 14);
            _ideaTitle = AddTextBox(_ideaPage, 16, 38, 620, 28, false);
            AddLabel(_ideaPage, "标签（逗号分隔，可空）", 16, 78);
            _ideaTags = AddTextBox(_ideaPage, 16, 102, 620, 28, false);
            AddLabel(_ideaPage, "正文（必填）", 16, 142);
            _ideaBody = AddTextBox(_ideaPage, 16, 166, 620, 270, true);
        }

        private void BuildAssignmentPage()
        {
            AddLabel(_assignmentPage, "标题（必填）", 16, 14);
            _assignmentTitle = AddTextBox(_assignmentPage, 16, 38, 620, 28, false);

            _deadlineEnabled = new CheckBox();
            _deadlineEnabled.Text = "设置截止时间";
            _deadlineEnabled.Location = new Point(16, 88);
            _deadlineEnabled.AutoSize = true;
            _deadlineEnabled.CheckedChanged += delegate { _deadline.Enabled = _deadlineEnabled.Checked; };
            _assignmentPage.Controls.Add(_deadlineEnabled);

            _deadline = CreateDateTimePicker(170, 84, 240);
            _deadline.Enabled = false;
            _assignmentPage.Controls.Add(_deadline);

            AddLabel(_assignmentPage, "预计耗时（分钟）", 16, 132);
            _minutes = new NumericUpDown();
            _minutes.Location = new Point(16, 156);
            _minutes.Width = 100;
            _minutes.Minimum = 5;
            _minutes.Maximum = 1440;
            _minutes.Value = 60;
            _assignmentPage.Controls.Add(_minutes);

            AddLabel(_assignmentPage, "优先级", 150, 132);
            _priority = new ComboBox();
            _priority.Location = new Point(150, 156);
            _priority.Width = 140;
            _priority.DropDownStyle = ComboBoxStyle.DropDownList;
            _priority.Items.Add("低");
            _priority.Items.Add("中");
            _priority.Items.Add("高");
            _priority.SelectedIndex = 1;
            _assignmentPage.Controls.Add(_priority);

            AddLabel(_assignmentPage, "作业只写入本地任务表，不会创建 Calendar 事件，也不会自动安排时间。", 16, 208);
        }

        private void BuildLecturePage()
        {
            AddLabel(_lecturePage, "标题（必填）", 16, 14);
            _lectureTitle = AddTextBox(_lecturePage, 16, 38, 620, 28, false);

            AddLabel(_lecturePage, "开始时间（必填）", 16, 78);
            _lectureStart = CreateDateTimePicker(16, 102, 240);
            _lectureStart.Value = DateTime.Now.AddHours(1);
            _lecturePage.Controls.Add(_lectureStart);

            _endEnabled = new CheckBox();
            _endEnabled.Text = "结束时间（可空）";
            _endEnabled.Location = new Point(280, 104);
            _endEnabled.AutoSize = true;
            _endEnabled.CheckedChanged += delegate { _lectureEnd.Enabled = _endEnabled.Checked; };
            _lecturePage.Controls.Add(_endEnabled);

            _lectureEnd = CreateDateTimePicker(420, 98, 216);
            _lectureEnd.Enabled = false;
            _lectureEnd.Value = DateTime.Now.AddHours(2);
            _lecturePage.Controls.Add(_lectureEnd);

            AddLabel(_lecturePage, "地点", 16, 142);
            _lectureLocation = AddTextBox(_lecturePage, 16, 166, 620, 28, false);

            AddLabel(_lecturePage, "主讲人", 16, 206);
            _lectureSpeaker = AddTextBox(_lecturePage, 16, 230, 620, 28, false);

            AddLabel(_lecturePage, "备注（可空）", 16, 270);
            _lectureNotes = AddTextBox(_lecturePage, 16, 294, 620, 120, true);

            _requiresPresentation = new CheckBox();
            _requiresPresentation.Text = "需要汇报（额外创建提前 72 小时提醒）";
            _requiresPresentation.Location = new Point(16, 428);
            _requiresPresentation.AutoSize = true;
            _lecturePage.Controls.Add(_requiresPresentation);
        }

        private Button CreateButton(string text, EventHandler handler)
        {
            Button button = new Button();
            button.Text = text;
            button.Width = 112;
            button.Height = 36;
            button.Margin = new Padding(6, 0, 0, 0);
            button.Click += handler;
            _buttons.Add(button);
            return button;
        }

        private static Label AddLabel(Control parent, string text, int x, int y)
        {
            Label label = new Label();
            label.Text = text;
            label.Location = new Point(x, y);
            label.AutoSize = true;
            parent.Controls.Add(label);
            return label;
        }

        private static TextBox AddTextBox(Control parent, int x, int y, int width, int height, bool multiline)
        {
            TextBox box = new TextBox();
            box.Location = new Point(x, y);
            box.Width = width;
            box.Height = height;
            box.Multiline = multiline;
            if (multiline)
            {
                box.ScrollBars = ScrollBars.Vertical;
                box.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            }
            else
            {
                box.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            }
            parent.Controls.Add(box);
            return box;
        }

        private static DateTimePicker CreateDateTimePicker(int x, int y, int width)
        {
            DateTimePicker picker = new DateTimePicker();
            picker.Location = new Point(x, y);
            picker.Width = width;
            picker.Format = DateTimePickerFormat.Custom;
            picker.CustomFormat = "yyyy-MM-dd HH:mm";
            return picker;
        }

        private void SaveClick(object sender, EventArgs e)
        {
            SaveCurrent(true);
        }

        private void SaveAndCloseClick(object sender, EventArgs e)
        {
            if (SaveCurrent(true)) Close();
        }

        private async void DigestClick(object sender, EventArgs e)
        {
            if (CurrentTabHasInput() && !SaveCurrent(false)) return;
            SetBusy(true, "正在同步 Zotero、深读论文并生成今日简报...");
            try
            {
                CliResult result = await Task.Run(delegate { return RunCli(new string[] { "knowledge", "digest" }); });
                if (result.ExitCode != 0)
                {
                    ShowCliError(result);
                }
                else
                {
                    SetStatus("知识整理完成，已尝试打开今日笔记。");
                }
            }
            catch (Exception error)
            {
                ShowError(error.Message);
            }
            finally
            {
                SetBusy(false, null);
            }
        }

        private async void OpenTodayClick(object sender, EventArgs e)
        {
            SetBusy(true, "正在打开今日日报...");
            try
            {
                CliResult result = await Task.Run(delegate { return RunCli(new string[] { "knowledge", "open-today" }); });
                if (result.ExitCode != 0)
                {
                    ShowCliError(result);
                }
                else
                {
                    SetStatus("已打开今日日报。");
                }
            }
            catch (Exception error)
            {
                ShowError(error.Message);
            }
            finally
            {
                SetBusy(false, null);
            }
        }

        private bool SaveCurrent(bool showSuccess)
        {
            try
            {
                CliResult result;
                if (_tabs.SelectedTab == _ideaPage)
                {
                    result = SaveIdea();
                }
                else if (_tabs.SelectedTab == _assignmentPage)
                {
                    result = SaveAssignment();
                }
                else
                {
                    result = SaveLecture();
                }
                if (result.ExitCode != 0)
                {
                    ShowCliError(result);
                    return false;
                }
                ClearCurrentTab();
                if (showSuccess) SetStatus("已保存到本地知识库/数据库，输入已清空。");
                return true;
            }
            catch (Exception error)
            {
                ShowError(error.Message);
                return false;
            }
        }

        private void ClearCurrentTab()
        {
            if (_tabs.SelectedTab == _ideaPage)
            {
                _ideaTitle.Text = "";
                _ideaTags.Text = "";
                _ideaBody.Text = "";
                _ideaTitle.Focus();
            }
            else if (_tabs.SelectedTab == _assignmentPage)
            {
                _assignmentTitle.Text = "";
                _deadlineEnabled.Checked = false;
                _deadline.Enabled = false;
                _deadline.Value = DateTime.Now;
                _minutes.Value = 60;
                _priority.SelectedIndex = 1;
                _assignmentTitle.Focus();
            }
            else
            {
                _lectureTitle.Text = "";
                _lectureStart.Value = DateTime.Now.AddHours(1);
                _endEnabled.Checked = false;
                _lectureEnd.Enabled = false;
                _lectureEnd.Value = DateTime.Now.AddHours(2);
                _lectureLocation.Text = "";
                _lectureSpeaker.Text = "";
                _lectureNotes.Text = "";
                _requiresPresentation.Checked = false;
                _lectureTitle.Focus();
            }
        }

        private CliResult SaveIdea()
        {
            string temporary = WriteTemporaryFile(_ideaBody.Text);
            try
            {
                List<string> arguments = new List<string>();
                arguments.Add("idea");
                arguments.Add("add");
                if (_ideaTitle.Text.Trim().Length > 0)
                {
                    arguments.Add("--title");
                    arguments.Add(_ideaTitle.Text.Trim());
                }
                if (_ideaTags.Text.Trim().Length > 0)
                {
                    arguments.Add("--tags");
                    arguments.Add(_ideaTags.Text.Trim());
                }
                arguments.Add("--body-file");
                arguments.Add(temporary);
                return RunCli(arguments.ToArray());
            }
            finally
            {
                TryDelete(temporary);
            }
        }

        private CliResult SaveAssignment()
        {
            string[] priorities = new string[] { "low", "medium", "high" };
            int priorityIndex = _priority.SelectedIndex;
            if (priorityIndex < 0 || priorityIndex >= priorities.Length) priorityIndex = 1;
            List<string> arguments = new List<string>();
            arguments.Add("task");
            arguments.Add("add");
            arguments.Add("--kind");
            arguments.Add("assignment");
            arguments.Add("--title");
            arguments.Add(_assignmentTitle.Text.Trim());
            arguments.Add("--minutes");
            arguments.Add(_minutes.Value.ToString(CultureInfo.InvariantCulture));
            arguments.Add("--priority");
            arguments.Add(priorities[priorityIndex]);
            if (_deadlineEnabled.Checked)
            {
                arguments.Add("--deadline");
                arguments.Add(_deadline.Value.ToString("yyyy-MM-ddTHH:mm:sszzz"));
            }
            return RunCli(arguments.ToArray());
        }

        private CliResult SaveLecture()
        {
            List<string> arguments = new List<string>();
            arguments.Add("lecture");
            arguments.Add("add");
            arguments.Add("--title");
            arguments.Add(_lectureTitle.Text.Trim());
            arguments.Add("--start");
            arguments.Add(_lectureStart.Value.ToString("yyyy-MM-ddTHH:mm:sszzz"));
            if (_endEnabled.Checked)
            {
                arguments.Add("--end");
                arguments.Add(_lectureEnd.Value.ToString("yyyy-MM-ddTHH:mm:sszzz"));
            }
            if (_lectureLocation.Text.Trim().Length > 0)
            {
                arguments.Add("--location");
                arguments.Add(_lectureLocation.Text.Trim());
            }
            if (_lectureSpeaker.Text.Trim().Length > 0)
            {
                arguments.Add("--speaker");
                arguments.Add(_lectureSpeaker.Text.Trim());
            }
            if (_requiresPresentation.Checked)
            {
                arguments.Add("--requires-presentation");
                arguments.Add("true");
            }
            string temporary = null;
            try
            {
                if (_lectureNotes.Text.Trim().Length > 0)
                {
                    temporary = WriteTemporaryFile(_lectureNotes.Text);
                    arguments.Add("--notes-file");
                    arguments.Add(temporary);
                }
                return RunCli(arguments.ToArray());
            }
            finally
            {
                if (temporary != null) TryDelete(temporary);
            }
        }

        private bool CurrentTabHasInput()
        {
            if (_tabs.SelectedTab == _ideaPage)
            {
                return _ideaTitle.Text.Trim().Length > 0
                    || _ideaTags.Text.Trim().Length > 0
                    || _ideaBody.Text.Trim().Length > 0;
            }
            if (_tabs.SelectedTab == _assignmentPage)
            {
                return _assignmentTitle.Text.Trim().Length > 0;
            }
            return _lectureTitle.Text.Trim().Length > 0
                || _lectureLocation.Text.Trim().Length > 0
                || _lectureSpeaker.Text.Trim().Length > 0
                || _lectureNotes.Text.Trim().Length > 0;
        }

        private CliResult RunCli(string[] arguments)
        {
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = _config.NodePath;
            start.Arguments = JoinQuoted(_config.CliPath, arguments);
            start.WorkingDirectory = Path.GetDirectoryName(_config.CliPath);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.StandardOutputEncoding = Encoding.UTF8;
            start.StandardErrorEncoding = Encoding.UTF8;
            using (Process process = Process.Start(start))
            {
                string stdout = process.StandardOutput.ReadToEnd();
                string stderr = process.StandardError.ReadToEnd();
                process.WaitForExit();
                CliResult result = new CliResult();
                result.ExitCode = process.ExitCode;
                result.Stdout = stdout;
                result.Stderr = stderr;
                return result;
            }
        }

        private static string JoinQuoted(string executable, string[] arguments)
        {
            StringBuilder builder = new StringBuilder();
            builder.Append(Quote(executable));
            for (int index = 0; index < arguments.Length; index++)
            {
                builder.Append(' ');
                builder.Append(Quote(arguments[index]));
            }
            return builder.ToString();
        }

        private static string Quote(string value)
        {
            if (value.Length == 0) return "\"\"";
            StringBuilder builder = new StringBuilder();
            builder.Append('"');
            int backslashes = 0;
            for (int index = 0; index < value.Length; index++)
            {
                char character = value[index];
                if (character == '\\')
                {
                    backslashes++;
                    builder.Append(character);
                }
                else if (character == '"')
                {
                    builder.Append('\\', backslashes + 1);
                    builder.Append('"');
                    backslashes = 0;
                }
                else
                {
                    backslashes = 0;
                    builder.Append(character);
                }
            }
            builder.Append('\\', backslashes);
            builder.Append('"');
            return builder.ToString();
        }

        private static string WriteTemporaryFile(string content)
        {
            string path = Path.Combine(Path.GetTempPath(), "person-agent-" + Guid.NewGuid().ToString("N") + ".txt");
            File.WriteAllText(path, content, new UTF8Encoding(false));
            return path;
        }

        private static void TryDelete(string path)
        {
            try
            {
                if (path != null && File.Exists(path)) File.Delete(path);
            }
            catch
            {
                // Temporary files are harmless if Windows still has a handle open.
            }
        }

        private void SetBusy(bool busy, string message)
        {
            UseWaitCursor = busy;
            for (int index = 0; index < _buttons.Count; index++) _buttons[index].Enabled = !busy;
            if (message != null) SetStatus(message);
        }

        private void SetStatus(string message)
        {
            _status.Text = message;
        }

        private void ShowCliError(CliResult result)
        {
            string message = result.Stderr;
            if (string.IsNullOrEmpty(message)) message = result.Stdout;
            if (string.IsNullOrEmpty(message)) message = "命令失败，退出码 " + result.ExitCode.ToString(CultureInfo.InvariantCulture) + "。";
            message = message.Trim();
            if (message.Length > 4000) message = message.Substring(0, 4000) + "...";
            MessageBox.Show(this, "操作失败：\n" + message, "Person Agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        private void ShowError(string message)
        {
            MessageBox.Show(this, message, "Person Agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                LauncherConfig config = LauncherConfig.Load();
                Application.Run(new PersonAgentForm(config));
            }
            catch (Exception error)
            {
                MessageBox.Show("无法启动 Person Agent：\n" + error.Message, "Person Agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }
}
