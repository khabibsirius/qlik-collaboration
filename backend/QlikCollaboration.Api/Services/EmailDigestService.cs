using System.Net;
using System.Net.Mail;

namespace QlikCollaboration.Api.Services;

/// <summary>
/// Sends the digest on a timer.
///
/// Why a digest and not an e-mail per comment: every comment already notifies the
/// whole BI team, so per-comment mail would be five or six people receiving one
/// message each time anyone types anything. That gets a rule created in Outlook
/// within a week, and then the channel is dead. A digest is the shape that survives.
///
/// Delivery uses System.Net.Mail rather than MailKit on purpose. It is in the
/// framework, so a bank deployment gains no new third-party component to review, and
/// an internal relay on port 25 is exactly the case it still handles well. It also
/// supports writing .eml files to a folder instead of sending, which is how this can
/// be verified before anyone has been given a relay address.
/// </summary>
public class EmailDigestService : BackgroundService
{
    private readonly IServiceProvider _services;
    private readonly IConfiguration _config;
    private readonly ILogger<EmailDigestService> _log;

    public EmailDigestService(
        IServiceProvider services, IConfiguration config,
        ILogger<EmailDigestService> log)
    {
        _services = services;
        _config = config;
        _log = log;
    }

    private bool Enabled => _config.GetValue("Email:Enabled", false);
    private int IntervalMinutes => Math.Max(5, _config.GetValue("Email:IntervalMinutes", 30));
    private int ReminderHours => Math.Max(1, _config.GetValue("Email:ReminderHours", 24));

    private string[] Recipients()
    {
        var listed = _config.GetSection("Email:Recipients").Get<string[]>() ?? [];
        return listed.Where(r => !string.IsNullOrWhiteSpace(r)).Select(r => r.Trim()).ToArray();
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!Enabled)
        {
            _log.LogInformation("Email digest is off (Email:Enabled=false).");
            return;
        }
        if (Recipients().Length == 0)
        {
            _log.LogWarning("Email digest is enabled but Email:Recipients is empty — nothing " +
                            "will be sent. List the BI team's e-mail addresses.");
            return;
        }

        _log.LogInformation("Email digest every {Minutes} min to {Recipients}",
                            IntervalMinutes, string.Join(", ", Recipients()));

        // A first pass immediately after start would mail everyone every time the
        // service restarts. Wait out one interval first.
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(TimeSpan.FromMinutes(IntervalMinutes), stoppingToken);
                await RunOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException) { break; }        // shutting down
            catch (Exception ex)
            {
                // A mail server that is down must not take the API with it.
                _log.LogError(ex, "Digest run failed; will try again next interval.");
            }
        }
    }

    /// <summary>One pass: build, decide whether it is worth sending, send.</summary>
    public async Task<string> RunOnceAsync(CancellationToken ct = default, bool force = false)
    {
        using var scope = _services.CreateScope();
        var builder = scope.ServiceProvider.GetRequiredService<DigestBuilder>();
        var report = await builder.BuildAsync();

        if (!force)
        {
            if (report.IsEmpty) return "nothing to report";

            // Something new is always worth sending. Nothing new is worth sending only
            // once a day, so a comment nobody answers resurfaces instead of being
            // quietly forgotten — without arriving every half hour in between.
            if (report.New.Count == 0)
            {
                var age = report.Since.HasValue ? DateTime.UtcNow - report.Since.Value : TimeSpan.MaxValue;
                if (age < TimeSpan.FromHours(ReminderHours))
                    return $"nothing new; reminder not due for another " +
                           $"{(TimeSpan.FromHours(ReminderHours) - age).TotalHours:F1}h";
            }
        }

        var email = BuildEmail();
        var recipients = Recipients();
        var message = Compose(email, report, recipients);

        Send(message);
        await builder.RecordSentAsync(report, string.Join(";", recipients));

        var summary = $"sent to {recipients.Length} recipient(s): " +
                      $"{report.New.Count} new, {report.Waiting.Count} waiting";
        _log.LogInformation("Digest {Summary}", summary);
        return summary;
    }

    public DigestEmail BuildEmail() => new(
        _config["Qlik:BaseUrl"] ?? "",
        _config["Email:InboxUrl"] ?? "");

    private MailMessage Compose(DigestEmail email, DigestReport report, string[] recipients)
    {
        var from = _config["Email:From"];
        if (string.IsNullOrWhiteSpace(from))
            throw new InvalidOperationException("Email:From is not set.");

        var msg = new MailMessage { From = new MailAddress(from), Subject = email.Subject(report) };
        foreach (var r in recipients) msg.To.Add(r);

        // Plain text as the body with HTML as an alternate view: a client that strips
        // HTML — some bank desktops do — still gets a readable message.
        msg.Body = email.PlainText(report);
        msg.IsBodyHtml = false;
        msg.AlternateViews.Add(AlternateView.CreateAlternateViewFromString(
            email.Html(report), null, "text/html"));
        return msg;
    }

    private void Send(MailMessage message)
    {
        var pickup = _config["Email:PickupDirectory"];

// SmtpClient is marked obsolete in favour of MailKit, which is the right call for
// internet-facing mail with modern auth. This talks to an internal relay on the bank
// network, where it works, and avoiding a new dependency is worth more here than the
// features MailKit would add.
#pragma warning disable SYSLIB0014
        using var client = new SmtpClient();

        if (!string.IsNullOrWhiteSpace(pickup))
        {
            // No server needed: writes a .eml file you can open in Outlook to see
            // exactly what would have been delivered.
            Directory.CreateDirectory(pickup);
            client.DeliveryMethod = SmtpDeliveryMethod.SpecifiedPickupDirectory;
            client.PickupDirectoryLocation = pickup;
        }
        else
        {
            var host = _config["Email:Host"];
            if (string.IsNullOrWhiteSpace(host))
                throw new InvalidOperationException(
                    "Set Email:Host (the SMTP relay) or Email:PickupDirectory (to write files instead).");
            client.Host = host;
            client.Port = _config.GetValue("Email:Port", 25);
            client.EnableSsl = _config.GetValue("Email:UseStartTls", false);

            var user = _config["Email:User"];
            if (!string.IsNullOrWhiteSpace(user))
                client.Credentials = new NetworkCredential(user, _config["Email:Password"]);
            else
                client.UseDefaultCredentials = true;   // relays that authorise by IP or AD
        }

        client.Send(message);
#pragma warning restore SYSLIB0014
    }
}
