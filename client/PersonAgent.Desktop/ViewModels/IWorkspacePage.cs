using System.Net.Http;
using PersonAgent.Desktop.Services;

namespace PersonAgent.Desktop.ViewModels;

public interface IWorkspacePage
{
    Task LoadAsync(bool refresh = false);
    void CloseDetail();
}

public abstract class PageViewModelBase : ObservableObject, IWorkspacePage
{
    private bool _isLoading;
    private bool _isRefreshing;
    private bool _hasData;
    private bool _hasError;
    private string _errorMessage = "";
    private bool _isPartial;
    private string _partialMessage = "";

    public bool IsLoading
    {
        get => _isLoading;
        protected set
        {
            if (SetProperty(ref _isLoading, value)) OnPropertyChanged(nameof(ShowInitialLoading));
        }
    }

    public bool IsRefreshing
    {
        get => _isRefreshing;
        protected set => SetProperty(ref _isRefreshing, value);
    }

    public bool HasData
    {
        get => _hasData;
        protected set
        {
            if (SetProperty(ref _hasData, value)) OnPropertyChanged(nameof(ShowInitialLoading));
        }
    }

    public bool ShowInitialLoading => IsLoading && !HasData;

    public bool HasError
    {
        get => _hasError;
        protected set => SetProperty(ref _hasError, value);
    }

    public string ErrorMessage
    {
        get => _errorMessage;
        protected set => SetProperty(ref _errorMessage, value);
    }

    public bool IsPartial
    {
        get => _isPartial;
        protected set => SetProperty(ref _isPartial, value);
    }

    public string PartialMessage
    {
        get => _partialMessage;
        protected set => SetProperty(ref _partialMessage, value);
    }

    protected void BeginLoad(bool refresh)
    {
        if (refresh && HasData)
        {
            IsRefreshing = true;
        }
        else
        {
            IsLoading = true;
        }
        HasError = false;
        ErrorMessage = "";
    }

    protected void EndLoad()
    {
        IsLoading = false;
        IsRefreshing = false;
        OnPropertyChanged(nameof(ShowInitialLoading));
    }

    protected void SetError(Exception error)
    {
        HasError = true;
        ErrorMessage = DescribeError(error);
    }

    protected static string DescribeError(Exception error) => error switch
    {
        LocalApiException api => api.Message,
        TaskCanceledException => "请求超时，请重试。",
        HttpRequestException => "无法连接本地服务，请重试。",
        _ => error.Message,
    };

    public abstract Task LoadAsync(bool refresh = false);

    public virtual void CloseDetail()
    {
    }
}
