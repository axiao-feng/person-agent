using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Input;
using System.Windows.Threading;
using PersonAgent.Desktop.Models;
using PersonAgent.Desktop.Services;

namespace PersonAgent.Desktop.ViewModels;

public sealed class SearchResultViewModel
{
    public SearchResultViewModel(SearchResult result)
    {
        Result = result;
    }

    public SearchResult Result { get; }
    public string Title => Result.Title;
    public string Source => Result.Source;
    public string TypeText => DisplayText.SearchTypeLabel(Result.Type);
    public string TypeKey => Result.Type;
    public string? Snippet => Result.Snippet;
    public bool HasSnippet => !string.IsNullOrWhiteSpace(Result.Snippet);
}

public sealed class AgentTurnViewModel
{
    public AgentTurnViewModel(TranscriptMessage message)
    {
        Sequence = message.Sequence;
        RoleKey = message.Role;
        Text = message.Text;
    }

    public int Sequence { get; }
    public string RoleKey { get; }
    public string Text { get; }
    public bool IsUser => RoleKey == "user";
    public bool IsAssistant => RoleKey == "assistant";
    public bool IsTool => RoleKey == "toolResult";
    public string RoleText => RoleKey switch
    {
        "user" => "你",
        "assistant" => "Agent",
        "toolResult" => "工具结果",
        _ => "系统",
    };
}

public sealed class CommandPaletteViewModel : ObservableObject
{
    private readonly LocalApiClient _client;
    private readonly Func<SearchResult, Task> _openResult;
    private readonly DispatcherTimer _debounce;
    private string _query = "";
    private bool _isSearching;
    private bool _isAsking;
    private bool _isLoadingTranscript;
    private string _errorMessage = "";
    private string? _conversationId;
    private string _conversationTitle = "";
    private SearchResultViewModel? _selectedResult;

    public CommandPaletteViewModel(LocalApiClient client, Func<SearchResult, Task> openResult, Action quickCapture)
    {
        _client = client;
        _openResult = openResult;
        QuickCapture = quickCapture;
        _debounce = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(350) };
        _debounce.Tick += (_, _) =>
        {
            _debounce.Stop();
            _ = SearchAsync();
        };
        SearchCommand = new AsyncRelayCommand(SearchAsync);
        AskCommand = new AsyncRelayCommand(AskAsync);
        OpenSelectedCommand = new AsyncRelayCommand(OpenSelectedAsync);
        NewConversationCommand = new RelayCommand(StartNewConversation);
        DeleteConversationCommand = new AsyncRelayCommand(DeleteConversationAsync, () => HasConversation);    }

    public ObservableCollection<SearchResultViewModel> Results { get; } = new();
    public ObservableCollection<AgentTurnViewModel> Transcript { get; } = new();
    public ICommand SearchCommand { get; }
    public ICommand AskCommand { get; }
    public ICommand OpenSelectedCommand { get; }
    public ICommand NewConversationCommand { get; }
    public ICommand DeleteConversationCommand { get; }
    public Action QuickCapture { get; }
    public Action? RequestClose { get; set; }

    public string Query
    {
        get => _query;
        set
        {
            if (!SetProperty(ref _query, value)) return;
            _debounce.Stop();
            if (string.IsNullOrWhiteSpace(value))
            {
                Results.Clear();
                OnPropertyChanged(nameof(HasResults));
                OnPropertyChanged(nameof(HasNoResults));
                return;
            }
            _debounce.Start();
        }
    }

    public SearchResultViewModel? SelectedResult
    {
        get => _selectedResult;
        set => SetProperty(ref _selectedResult, value);
    }

    public bool IsSearching
    {
        get => _isSearching;
        private set => SetProperty(ref _isSearching, value);
    }

    public bool IsAsking
    {
        get => _isAsking;
        private set => SetProperty(ref _isAsking, value);
    }

    public bool IsLoadingTranscript
    {
        get => _isLoadingTranscript;
        private set => SetProperty(ref _isLoadingTranscript, value);
    }

    public bool HasConversation => !string.IsNullOrWhiteSpace(_conversationId);

    public string ConversationHint => HasConversation
        ? $"继续：{(string.IsNullOrWhiteSpace(_conversationTitle) ? "未命名对话" : _conversationTitle)}"
        : "新对话（第一次提问后自动保存）";

    public string ErrorMessage
    {
        get => _errorMessage;
        private set
        {
            if (SetProperty(ref _errorMessage, value)) OnPropertyChanged(nameof(HasError));
        }
    }

    public bool HasError => !string.IsNullOrWhiteSpace(ErrorMessage);
    public bool HasResults => Results.Count > 0;
    public bool HasNoResults => !IsSearching && Results.Count == 0 && !string.IsNullOrWhiteSpace(Query);
    public bool HasTranscript => Transcript.Count > 0;

    /// <summary>Restores the most recent active conversation so the next question continues it.</summary>
    public async Task LoadConversationAsync()
    {
        IsLoadingTranscript = true;
        try
        {
            var list = await _client.GetConversationsAsync("active", 1);
            var latest = list.Items.FirstOrDefault();
            if (latest is null)
            {
                ResetConversation();
                return;
            }
            var transcript = await _client.GetConversationMessagesAsync(latest.Id, 200);
            _conversationId = transcript.Conversation.Id;
            _conversationTitle = transcript.Conversation.Title ?? "";
            Transcript.Clear();
            foreach (var message in transcript.Messages)
            {
                Transcript.Add(new AgentTurnViewModel(message));
            }
            NotifyConversationChanged();
        }
        catch (Exception error)
        {
            ErrorMessage = $"无法读取上次对话：{error.Message}";
        }
        finally
        {
            IsLoadingTranscript = false;
        }
    }

    private void StartNewConversation()
    {
        ResetConversation();
        ErrorMessage = "";
        Query = "";
        OnPropertyChanged(nameof(HasNoResults));
    }

    private async Task DeleteConversationAsync()
    {
        var conversationId = _conversationId;
        if (string.IsNullOrWhiteSpace(conversationId)) return;
        var confirmed = MessageBox.Show(
            "删除后该对话及其消息无法恢复。确定删除？",
            "删除对话",
            MessageBoxButton.OKCancel,
            MessageBoxImage.Warning,
            MessageBoxResult.Cancel);
        if (confirmed != MessageBoxResult.OK) return;
        IsAsking = true;
        ErrorMessage = "";
        try
        {
            await _client.DeleteConversationAsync(conversationId);
            ResetConversation();
        }
        catch (Exception error)
        {
            ErrorMessage = error.Message;
        }
        finally
        {
            IsAsking = false;
        }
    }

    private void ResetConversation()
    {
        _conversationId = null;
        _conversationTitle = "";
        Transcript.Clear();
        NotifyConversationChanged();
    }

    private void NotifyConversationChanged()
    {
        OnPropertyChanged(nameof(HasTranscript));
        OnPropertyChanged(nameof(HasConversation));
        OnPropertyChanged(nameof(ConversationHint));
        (DeleteConversationCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
    }

    private async Task SearchAsync()
    {
        var query = Query.Trim();
        if (query.Length == 0) return;
        IsSearching = true;
        ErrorMessage = "";
        try
        {
            var response = await _client.SearchAsync(query, null, 20);
            Results.Clear();
            foreach (var item in response.Items) Results.Add(new SearchResultViewModel(item));
            OnPropertyChanged(nameof(HasResults));
            OnPropertyChanged(nameof(HasNoResults));
        }
        catch (Exception error)
        {
            ErrorMessage = error.Message;
        }
        finally
        {
            IsSearching = false;
            OnPropertyChanged(nameof(HasNoResults));
        }
    }

    private async Task AskAsync()
    {
        var query = Query.Trim();
        if (query.Length == 0) return;
        IsAsking = true;
        ErrorMessage = "";
        try
        {
            var response = await _client.SendAgentMessageAsync(query, _conversationId);
            _conversationId = response.ConversationId;
            _conversationTitle = response.Conversation.Title ?? _conversationTitle;
            if (response.Messages.Count > 0)
            {
                foreach (var message in response.Messages)
                {
                    Transcript.Add(new AgentTurnViewModel(message));
                }
            }
            else if (!string.IsNullOrWhiteSpace(response.Answer))
            {
                // Defensive: still show the answer if the service returned no transcript rows.
                Transcript.Add(new AgentTurnViewModel(new TranscriptMessage
                {
                    Sequence = Transcript.Count + 1,
                    Role = "user",
                    Text = query,
                }));
                Transcript.Add(new AgentTurnViewModel(new TranscriptMessage
                {
                    Sequence = Transcript.Count + 1,
                    Role = "assistant",
                    Text = response.Answer,
                }));
            }
            NotifyConversationChanged();
            Query = "";
        }
        catch (Exception error)
        {
            ErrorMessage = error.Message;
        }
        finally
        {
            IsAsking = false;
        }
    }

    private async Task OpenSelectedAsync()
    {
        if (SelectedResult is null) return;
        await _openResult(SelectedResult.Result);
        RequestClose?.Invoke();
    }
}
