using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace PersonAgent.Desktop.Services;

public sealed class BackendSession : IAsyncDisposable
{
    private readonly Process _process;
    private readonly StringBuilder _stderr;
    private bool _disposed;

    internal BackendSession(Process process, int port, string token, StringBuilder stderr, string launchDescription)
    {
        _process = process;
        Port = port;
        Token = token;
        _stderr = stderr;
        LaunchDescription = launchDescription;
    }

    public int Port { get; }
    public string Token { get; }
    public string LaunchDescription { get; }

    public string Diagnostics
    {
        get
        {
            lock (_stderr)
            {
                return _stderr.ToString().Trim();
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        try
        {
            if (!_process.HasExited)
            {
                try
                {
                    _process.StandardInput.Close();
                }
                catch
                {
                    // The service may already be shutting down.
                }
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                try
                {
                    await _process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    try
                    {
                        _process.Kill(entireProcessTree: true);
                    }
                    catch
                    {
                        // The process may have exited between the checks.
                    }
                }
            }
        }
        finally
        {
            _process.Dispose();
        }
    }
}

public static class BackendLauncher
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    public static async Task<BackendSession> StartAsync(CancellationToken cancellationToken = default)
    {
        var plan = ResolveLaunchPlan();
        var token = CreateToken();
        var startInfo = new ProcessStartInfo(plan.FileName)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = plan.WorkingDirectory,
        };
        foreach (var argument in plan.Arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }
        startInfo.Environment["PERSON_AGENT_SESSION_TOKEN"] = token;

        var process = new Process
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true,
        };
        try
        {
            if (!process.Start())
            {
                throw new InvalidOperationException("无法启动本地服务进程。");
            }
        }
        catch (Exception error)
        {
            process.Dispose();
            throw new InvalidOperationException(
                $"无法启动本地服务：{plan.Description}\n请先运行 pnpm build，或通过 PERSON_AGENT_CLI 指定 dist/src/cli.js。",
                error);
        }

        var stderr = new StringBuilder();
        _ = Task.Run(async () =>
        {
            try
            {
                string? line;
                while ((line = await process.StandardError.ReadLineAsync().ConfigureAwait(false)) is not null)
                {
                    lock (stderr)
                    {
                        if (stderr.Length < 32_000)
                        {
                            stderr.AppendLine(line);
                        }
                    }
                }
            }
            catch
            {
                // Process teardown closes the stream.
            }
        });

        try
        {
            var line = await ReadReadyLineAsync(process.StandardOutput, TimeSpan.FromSeconds(20), cancellationToken)
                .ConfigureAwait(false);
            var ready = JsonSerializer.Deserialize<ReadyLine>(line, JsonOptions);
            if (ready is null || ready.Event != "ready" || ready.Port <= 0)
            {
                throw new InvalidOperationException($"本地服务返回了无法识别的就绪消息：{line}");
            }
            if (!string.Equals(ready.ProtocolVersion, "1", StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    $"本地服务协议版本 {ready.ProtocolVersion} 与客户端不兼容（需要 1）。请更新客户端或本地服务。");
            }
            _ = Task.Run(() => DrainAsync(process.StandardOutput));
            return new BackendSession(process, ready.Port, token, stderr, plan.Description);
        }
        catch (Exception error)
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }
            }
            catch
            {
                // Ignore teardown races.
            }
            try
            {
                using var wait = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await process.WaitForExitAsync(wait.Token).ConfigureAwait(false);
            }
            catch
            {
                // The process may still be exiting.
            }
            string details;
            lock (stderr)
            {
                details = stderr.ToString().Trim();
            }
            process.Dispose();
            var suffix = string.IsNullOrWhiteSpace(details) ? "" : $"\n\n服务诊断：\n{details}";
            throw new InvalidOperationException(
                $"本地服务未能就绪。启动命令：{plan.Description}{suffix}",
                error);
        }
    }

    private static async Task<string> ReadReadyLineAsync(
        StreamReader reader,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);
        try
        {
            while (true)
            {
                var line = await reader.ReadLineAsync(timeoutSource.Token).ConfigureAwait(false);
                if (line is null)
                {
                    throw new InvalidOperationException("本地服务在输出就绪消息前退出。");
                }
                if (!string.IsNullOrWhiteSpace(line))
                {
                    return line.Trim();
                }
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException($"本地服务启动超时（{timeout.TotalSeconds:0} 秒）。");
        }
    }

    private static async Task DrainAsync(StreamReader reader)
    {
        try
        {
            while (await reader.ReadLineAsync().ConfigureAwait(false) is not null)
            {
                // The protocol has no streaming messages in phase 1.
            }
        }
        catch
        {
            // Process teardown closes the stream.
        }
    }

    private static string CreateToken()
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static LaunchPlan ResolveLaunchPlan()
    {
        var explicitCommand = Environment.GetEnvironmentVariable("PERSON_AGENT_SERVE_COMMAND");
        if (!string.IsNullOrWhiteSpace(explicitCommand))
        {
            var executable = Environment.ExpandEnvironmentVariables(explicitCommand.Trim());
            return new LaunchPlan(
                executable,
                Directory.GetCurrentDirectory(),
                new[] { "serve", "--port", "0" },
                executable);
        }

        var explicitCli = Environment.GetEnvironmentVariable("PERSON_AGENT_CLI");
        if (!string.IsNullOrWhiteSpace(explicitCli) && File.Exists(explicitCli))
        {
            var node = ResolveNode();
            return new LaunchPlan(
                node,
                Path.GetDirectoryName(explicitCli) ?? Directory.GetCurrentDirectory(),
                new[] { explicitCli, "serve", "--port", "0" },
                $"{node} {explicitCli} serve --port 0");
        }

        foreach (var start in CandidateDirectories())
        {
            var directory = new DirectoryInfo(start);
            for (var depth = 0; depth < 10 && directory is not null; depth += 1)
            {
                var cli = Path.Combine(directory.FullName, "dist", "src", "cli.js");
                if (File.Exists(cli) && LooksLikePersonAgentRepository(directory.FullName))
                {
                    var node = ResolveNode();
                    return new LaunchPlan(
                        node,
                        directory.FullName,
                        new[] { cli, "serve", "--port", "0" },
                        $"{node} {cli} serve --port 0");
                }
                directory = directory.Parent;
            }
        }

        return new LaunchPlan(
            "person-agent",
            Directory.GetCurrentDirectory(),
            new[] { "serve", "--port", "0" },
            "person-agent serve --port 0");
    }

    private static IEnumerable<string> CandidateDirectories()
    {
        yield return AppContext.BaseDirectory;
        yield return Directory.GetCurrentDirectory();
    }

    private static bool LooksLikePersonAgentRepository(string directory)
    {
        var package = Path.Combine(directory, "package.json");
        if (!File.Exists(package)) return false;
        try
        {
            return File.ReadAllText(package).Contains("\"name\": \"person-agent\"", StringComparison.Ordinal);
        }
        catch (IOException)
        {
            return false;
        }
    }

    private static string ResolveNode()
    {
        var configured = Environment.GetEnvironmentVariable("PERSON_AGENT_NODE");
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured))
        {
            return configured;
        }
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var systemNode = Path.Combine(programFiles, "nodejs", "node.exe");
        return File.Exists(systemNode) ? systemNode : "node";
    }

    private sealed class LaunchPlan
    {
        public LaunchPlan(string fileName, string workingDirectory, IReadOnlyList<string> arguments, string description)
        {
            FileName = fileName;
            WorkingDirectory = workingDirectory;
            Arguments = arguments;
            Description = description;
        }

        public string FileName { get; }
        public string WorkingDirectory { get; }
        public IReadOnlyList<string> Arguments { get; }
        public string Description { get; }
    }

    private sealed class ReadyLine
    {
        public string Event { get; set; } = "";
        public int Port { get; set; }
        public string ProtocolVersion { get; set; } = "";
    }
}
