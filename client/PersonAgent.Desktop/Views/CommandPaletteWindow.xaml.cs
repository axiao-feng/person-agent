using System.Windows;
using System.Windows.Input;
using PersonAgent.Desktop.Models;
using PersonAgent.Desktop.Services;
using PersonAgent.Desktop.ViewModels;

namespace PersonAgent.Desktop.Views;

public partial class CommandPaletteWindow : Window
{
    private readonly CommandPaletteViewModel _viewModel;

    public CommandPaletteWindow(
        LocalApiClient client,
        Func<SearchResult, Task> openResult,
        Action quickCapture)
    {
        InitializeComponent();
        _viewModel = new CommandPaletteViewModel(client, openResult, quickCapture)
        {
            RequestClose = Close,
        };
        DataContext = _viewModel;
        Loaded += (_, _) => QueryTextBox.Focus();
    }

    private void QueryTextBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Enter) return;
        e.Handled = true;
        if ((Keyboard.Modifiers & ModifierKeys.Control) == ModifierKeys.Control)
        {
            _viewModel.AskCommand.Execute(null);
        }
        else
        {
            _viewModel.SearchCommand.Execute(null);
        }
    }

    private void Results_MouseDoubleClick(object sender, MouseButtonEventArgs e)
    {
        _viewModel.OpenSelectedCommand.Execute(null);
    }

    private void QuickCapture_Click(object sender, RoutedEventArgs e)
    {
        Close();
        _viewModel.QuickCapture();
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            Close();
            e.Handled = true;
            return;
        }
        base.OnKeyDown(e);
    }
}
