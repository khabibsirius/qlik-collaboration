using System.Collections.Concurrent;

namespace QlikCollaboration.Api.Services;

/// <summary>
/// Which browser origins may call this API — and, when one that was supposed to be
/// allowed is not, saying so.
///
/// An origin is scheme + host + port and nothing else, and the browser sends it in
/// exactly that form. Every value ever typed into this setting by hand has carried
/// something extra: a trailing slash copied out of the address bar, a path, stray
/// whitespace, the host in different case, or two hosts separated by a comma. The
/// built-in WithOrigins() compares the raw strings, so any of those rejects every
/// request from the one host that was meant to be allowed — and rejects it in
/// silence. Nothing is logged, the browser reports a bare network error, and the
/// panel can only say the backend did not answer. Hours go into checking the
/// firewall, the port and the database because of a slash.
///
/// So: normalise both sides before comparing, report at startup anything that had to
/// be corrected, and log the first request from each origin that is turned away.
/// </summary>
public sealed class CorsOrigins
{
    private readonly HashSet<string> _allowed = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _alreadyReported = new();
    private ILogger? _log;

    /// <summary>Values that were accepted but had to be corrected first: (as configured, as used).</summary>
    public List<(string Configured, string Used)> Corrected { get; } = [];

    /// <summary>Values that are not an origin at all and were dropped.</summary>
    public List<string> Rejected { get; } = [];

    /// <summary>Nothing configured, or "*": any origin may call. Development only.</summary>
    public bool AllowAny { get; }

    public IReadOnlyCollection<string> Allowed => _allowed;

    public CorsOrigins(IEnumerable<string?>? configured)
    {
        // One environment variable per origin is the documented form, but a
        // comma-separated list is the obvious guess and used to produce a single
        // nonsense origin that matched nothing. Accept both.
        var values = (configured ?? [])
            .SelectMany(v => (v ?? "").Split([',', ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            .ToArray();

        if (values.Length == 0 || values.Contains("*"))
        {
            AllowAny = true;
            return;
        }

        foreach (var value in values)
        {
            var normalized = Normalize(value);
            if (normalized is null)
            {
                Rejected.Add(value);
                continue;
            }
            if (!string.Equals(normalized, value, StringComparison.Ordinal))
                Corrected.Add((value, normalized));
            _allowed.Add(normalized);
        }

        // Every configured value was unusable. Falling back to "any origin" would turn
        // a typo into an open API, so this stays closed and the startup log says why.
        AllowAny = false;
    }

    /// <summary>
    /// scheme + host + port, lower-cased, no path and no trailing slash — the exact
    /// shape a browser puts in the Origin header. Null when the value is not a usable
    /// http(s) origin at all.
    /// </summary>
    public static string? Normalize(string? value)
    {
        var text = (value ?? "").Trim();
        if (text.Length == 0) return null;

        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            return null;

        // GetLeftPart(Authority) drops the path and the port when it is the default
        // for the scheme — which is also what the browser does, so :443 and :80 in
        // the setting stop being a mismatch.
        return uri.GetLeftPart(UriPartial.Authority).ToLowerInvariant();
    }

    /// <summary>
    /// The CORS policy predicate. Logs the first request from each origin it turns
    /// away: without this the rejection reaches nobody, on either side.
    /// </summary>
    public bool IsAllowed(string origin)
    {
        var normalized = Normalize(origin);
        if (normalized is not null && _allowed.Contains(normalized)) return true;

        if (_alreadyReported.TryAdd(origin, 0))
            _log?.LogWarning(
                "Refused a browser request from origin {Origin} because it is not in " +
                "Cors:AllowedOrigins ({Allowed}). The browser shows this to the user as " +
                "\"no response\", not as a permission error. Add it — the value must be " +
                "scheme, host and port only, e.g. https://qlik.bank.local — via " +
                "QLIK_ORIGIN in .env, or Cors__AllowedOrigins__0 as an environment variable.",
                origin, string.Join(", ", _allowed));

        return false;
    }

    /// <summary>The app's logger, once there is one — this object is built before it.</summary>
    public void UseLogger(ILogger log) => _log = log;

    /// <summary>What was configured, what is actually in force, and what was wrong with it.</summary>
    public void ReportAtStartup(ILogger log)
    {
        UseLogger(log);

        if (AllowAny)
        {
            log.LogInformation("CORS: any origin (development). Set QLIK_ORIGIN to your Qlik host in production.");
            return;
        }

        foreach (var (configured, used) in Corrected)
            log.LogWarning(
                "CORS origin {Configured} is not the form a browser sends; matching {Used} instead. " +
                "An origin is scheme, host and port only — no trailing slash and no path.",
                configured, used);

        foreach (var value in Rejected)
            log.LogError(
                "CORS origin {Value} is not a usable http(s) origin and has been ignored. " +
                "Requests from it will be refused, which the panel reports as \"no response\".",
                value);

        if (_allowed.Count == 0)
            log.LogCritical(
                "CORS: no usable origin is configured, so every request from a browser will " +
                "be refused and the panel will report that the backend did not answer. Set " +
                "QLIK_ORIGIN to your Qlik host, e.g. https://qlik.bank.local");
        else
            log.LogInformation("CORS: {Origins}", string.Join(", ", _allowed));
    }
}
