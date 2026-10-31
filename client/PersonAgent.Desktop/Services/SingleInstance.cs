using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;

namespace PersonAgent.Desktop.Services;

/// <summary>
/// Keeps one interactive client per Windows session. A second launch forwards
/// its deep link to the running window instead of starting another backend.
/// </summary>
public sealed class SingleInstance : IDisposable
{
    private const string MutexName = @"Local\PersonAgent.Desktop.SingleInstance.v1";
    private static readonly string PipeName =
        $"PersonAgent.Desktop.Commands.v1.{Process.GetCurrentProcess().SessionId}";

    private readonly Mutex? _mutex;
    private readonly bool _ownsMutex;
    private readonly CancellationTokenSource _cancellation = new();
    private Task? _serverLoop;
    private bool _disposed;

    private SingleInstance(Mutex? mutex, bool ownsMutex)
    {
        _mutex = mutex;
        _ownsMutex = ownsMutex;
    }

    public bool IsPrimary => _ownsMutex;

    public event Action<string>? CommandReceived;

    public static SingleInstance Acquire()
    {
        var mutex = new Mutex(initiallyOwned: true, MutexName, out var createdNew);
        var instance = new SingleInstance(createdNew ? mutex : null, createdNew);
        if (createdNew)
        {
            instance.StartServer();
        }
        else
        {
            mutex.Dispose();
        }
        return instance;
    }

    public static async Task<bool> ForwardAsync(string payload, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                using var client = new NamedPipeClientStream(
                    ".",
                    PipeName,
                    PipeDirection.Out,
                    PipeOptions.Asynchronous);
                await client.ConnectAsync(500).ConfigureAwait(false);
                using var writer = new StreamWriter(client, new UTF8Encoding(false))
                {
                    AutoFlush = true,
                };
                await writer.WriteLineAsync(payload).ConfigureAwait(false);
                return true;
            }
            catch (TimeoutException)
            {
                // The primary instance is still starting its pipe server.
            }
            catch (IOException)
            {
                // The primary instance may be between pipe connections.
            }
            catch (UnauthorizedAccessException)
            {
                return false;
            }
            await Task.Delay(120).ConfigureAwait(false);
        }
        return false;
    }

    private void StartServer()
    {
        _serverLoop = Task.Run(async () =>
        {
            while (!_cancellation.IsCancellationRequested)
            {
                try
                {
                    using var server = new NamedPipeServerStream(
                        PipeName,
                        PipeDirection.In,
                        1,
                        PipeTransmissionMode.Byte,
                        PipeOptions.Asynchronous);
                    await server.WaitForConnectionAsync(_cancellation.Token).ConfigureAwait(false);
                    using var reader = new StreamReader(server, Encoding.UTF8);
                    var line = await reader.ReadLineAsync().ConfigureAwait(false);
                    if (!string.IsNullOrWhiteSpace(line))
                    {
                        CommandReceived?.Invoke(line.Trim());
                    }
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (IOException)
                {
                    await Task.Delay(100).ConfigureAwait(false);
                }
                catch (Exception)
                {
                    if (_cancellation.IsCancellationRequested) break;
                    await Task.Delay(250).ConfigureAwait(false);
                }
            }
        });
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _cancellation.Cancel();
        try
        {
            _serverLoop?.Wait(TimeSpan.FromMilliseconds(500));
        }
        catch
        {
            // Shutdown must not be blocked by a stuck pipe read.
        }
        _cancellation.Dispose();
        if (_ownsMutex && _mutex is not null)
        {
            try
            {
                _mutex.ReleaseMutex();
            }
            catch (ApplicationException)
            {
                // The mutex was already released or abandoned.
            }
        }
        _mutex?.Dispose();
    }
}
