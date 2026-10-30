using System.Collections.ObjectModel;
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

public sealed class CommandPaletteViewModel : ObservableObject
{
    private readonly LocalApiClient _client;
    private readonly Func<SearchResult, Task> _openResult;
    private readonly DispatcherTimer _debounce;
    private string _query = "";
    private bool _isSearching;
    private bool _isAsking;
    private string _answer = "";
    private string _errorMessage = "";
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
    }

    public ObservableCollection<SearchResultViewModel> Results { get; } = new();
    public ICommand SearchCommand { get; }
    public ICommand AskCommand { get; }
    public ICommand OpenSelectedCommand { get; }
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

    public string Answer
    {
        get => _answer;
        private set
        {
            if (SetProperty(ref _answer, value)) OnPropertyChanged(nameof(HasAnswer));
        }
    }

    public bool HasAnswer => !string.IsNullOrWhiteSpace(Answer);

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

    private async Task SearchAsync()
    {
        var query = Query.Trim();
        if (query.Length == 0) return;
        IsSearching = true;
        ErrorMessage = "";
        Answer = "";
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
            var response = await _client.SendAgentMessageAsync(query);
            Answer = response.Answer;
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
