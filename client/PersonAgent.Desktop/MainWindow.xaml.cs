using System.ComponentModel;
using System.Windows;
using PersonAgent.Desktop.ViewModels;

namespace PersonAgent.Desktop;

public partial class MainWindow : Window
{
    private bool _shuttingDown;

    public MainWindow()
    {
        InitializeComponent();
    }

    private async void Window_Closing(object? sender, CancelEventArgs e)
    {
        if (_shuttingDown) return;
        _shuttingDown = true;
        e.Cancel = true;
        try
        {
            if (DataContext is MainViewModel viewModel)
            {
                await viewModel.ShutdownAsync();
            }
        }
        catch
        {
            // Closing must not be blocked by backend teardown failures.
        }
        finally
        {
            Close();
        }
    }
}
