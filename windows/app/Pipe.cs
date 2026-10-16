using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Mystical;

/// `\\.\pipe\mystical` — the WSL side's line to the app, and a second instance's.
/// One request per connection: a UTF-8 JSON line in, one JSON line out.
/// windows/probe.sh and capture.sh run `Mystical.exe --probe` / `--capture`
/// through interop, which is this file's client half; a second bare instance
/// forwards a mystical:// link the same way. Anyone local can connect — the same
/// trust as the Mac's distributed notifications: nothing here changes bridge
/// state, and nothing is captured unless a local process asks.
public static class Pipe
{
    public const string Name = "mystical";
    static readonly UTF8Encoding Utf8 = new(false);

    /// Serves on a background thread until `ct` is cancelled. `handle` runs on
    /// the UI thread (through `ui`), one request at a time; its node is the reply.
    public static void Serve(Func<JsonElement, Task<JsonNode>> handle, SynchronizationContext ui, CancellationToken ct)
    {
        new Thread(() => Loop(handle, ui, ct)) { IsBackground = true, Name = "mystical-pipe" }.Start();
    }

    static void Loop(Func<JsonElement, Task<JsonNode>> handle, SynchronizationContext ui, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                using var server = new NamedPipeServerStream(Name, PipeDirection.InOut, 1,
                                                             PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
                server.WaitForConnectionAsync(ct).GetAwaiter().GetResult();
                using var reader = new StreamReader(server, Utf8, false, 4096, leaveOpen: true);
                using var writer = new StreamWriter(server, Utf8, 4096, leaveOpen: true) { AutoFlush = true };
                JsonNode reply;
                try
                {
                    using var doc = JsonDocument.Parse(reader.ReadLine() ?? "");
                    var req = doc.RootElement.Clone();
                    var done = new TaskCompletionSource<JsonNode>();
                    ui.Post(async _ =>
                    {
                        try { done.SetResult(await handle(req)); }
                        catch (Exception e) { done.SetException(e); }
                    }, null);
                    reply = done.Task.GetAwaiter().GetResult();
                }
                catch (JsonException)
                {
                    reply = new JsonObject { ["ok"] = false, ["error"] = "bad request: one JSON object per line" };
                }
                catch (Exception e)
                {
                    reply = new JsonObject { ["ok"] = false, ["error"] = e.Message };
                }
                writer.WriteLine(reply.ToJsonString());
                server.WaitForPipeDrain();
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (IOException)
            {
                // A client that vanished mid-line: serve the next one.
            }
        }
    }

    /// The client half: the reply line, or null when nothing listens within
    /// `timeoutMs` (the app isn't running).
    public static string? Send(string json, int timeoutMs = 3000)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", Name, PipeDirection.InOut);
            client.Connect(timeoutMs);
            using var writer = new StreamWriter(client, Utf8, 4096, leaveOpen: true) { AutoFlush = true };
            writer.WriteLine(json);
            using var reader = new StreamReader(client, Utf8, false, 4096, leaveOpen: true);
            return reader.ReadLine();
        }
        catch (Exception e) when (e is TimeoutException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
