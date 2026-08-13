using System.Net;
using System.Text;

namespace QlikCollaboration.Api.Services;

/// <summary>
/// Renders the digest.
///
/// Outlook on Windows renders HTML mail with Word's engine, not a browser one, so
/// this is deliberately old-fashioned: table layout, inline styles, explicit pixel
/// widths, and colours on both the CSS property and the bgcolor attribute. Flexbox,
/// grid, and a stylesheet in &lt;head&gt; are silently dropped there — the same markup
/// that looks right in a browser preview arrives as an unstyled column of text.
/// The team reads this in Outlook, so Outlook is what it is built for.
/// </summary>
public class DigestEmail
{
    private readonly string _qlikBaseUrl;
    private readonly string _inboxUrl;

    public DigestEmail(string qlikBaseUrl, string inboxUrl)
    {
        _qlikBaseUrl = (qlikBaseUrl ?? "").TrimEnd('/');
        _inboxUrl = (inboxUrl ?? "").TrimEnd('/');
    }

    private static string Esc(string? s) => WebUtility.HtmlEncode(s ?? "");

    private static string Trim(string body, int max = 160) =>
        body.Length <= max ? body : body[..max].TrimEnd() + "…";

    private string SheetUrl(DigestItem i) =>
        string.IsNullOrEmpty(_qlikBaseUrl)
            ? ""
            : $"{_qlikBaseUrl}/sense/app/{Uri.EscapeDataString(i.AppId)}" +
              $"/sheet/{Uri.EscapeDataString(i.SheetId)}/state/analysis";

    public string Subject(DigestReport r)
    {
        // The subject is the whole message for anyone reading on a phone in a meeting,
        // so it carries the two numbers that decide whether to open it.
        var parts = new List<string>();
        if (r.New.Count > 0) parts.Add($"{r.New.Count} new");
        if (r.Waiting.Count > 0) parts.Add($"{r.Waiting.Count} waiting for a reply");
        return parts.Count > 0
            ? "Qlik dashboard feedback: " + string.Join(", ", parts)
            : "Qlik dashboard feedback";
    }

    public string PlainText(DigestReport r)
    {
        var sb = new StringBuilder();
        sb.AppendLine(Subject(r));
        sb.AppendLine(new string('=', 60));
        sb.AppendLine();

        if (r.New.Count > 0)
        {
            sb.AppendLine($"NEW SINCE {(r.Since?.ToLocalTime().ToString("dd MMM HH:mm") ?? "yesterday")}");
            sb.AppendLine();
            foreach (var g in r.New.GroupBy(i => (i.Dashboard, i.Sheet)))
            {
                sb.AppendLine($"  {g.Key.Dashboard} > {g.Key.Sheet}");
                foreach (var i in g)
                    sb.AppendLine($"    [{i.CreatedAt.ToLocalTime():HH:mm}] {i.Author}" +
                                  $"{(i.IsReply ? " (reply)" : "")}: {Trim(i.Body)}");
                sb.AppendLine();
            }
        }

        if (r.Waiting.Count > 0)
        {
            sb.AppendLine($"STILL WAITING FOR A REPLY ({r.Waiting.Count})");
            sb.AppendLine();
            foreach (var i in r.Waiting)
                sb.AppendLine($"  [{i.CreatedAt.ToLocalTime():dd MMM}] {i.Dashboard} > {i.Sheet}" +
                              $" - {i.Author}: {Trim(i.Body, 100)}");
            sb.AppendLine();
        }

        if (!string.IsNullOrEmpty(_inboxUrl)) sb.AppendLine($"Open the team inbox: {_inboxUrl}");
        return sb.ToString();
    }

    public string Html(DigestReport r)
    {
        var sb = new StringBuilder();
        sb.Append(
            """
            <html><body style="margin:0;padding:0;background:#f4f6f8;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f6f8"
                   style="background:#f4f6f8;padding:20px 0;">
            <tr><td align="center">
            <table width="640" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff"
                   style="width:640px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;
                          font-family:'Segoe UI',Arial,sans-serif;color:#1f2937;">
            """);

        // ---- header ----
        sb.Append($"""
            <tr><td bgcolor="#009845" style="background:#009845;padding:16px 22px;border-radius:8px 8px 0 0;">
              <div style="font-size:17px;font-weight:600;color:#ffffff;">Qlik dashboard feedback</div>
              <div style="font-size:12.5px;color:#d6f0e0;padding-top:3px;">{Esc(Summary(r))}</div>
            </td></tr>
            """);

        // ---- new since last digest ----
        if (r.New.Count > 0)
        {
            sb.Append(SectionHead("New since " +
                (r.Since.HasValue ? r.Since.Value.ToLocalTime().ToString("dd MMM, HH:mm") : "yesterday")));

            foreach (var g in r.New.GroupBy(i => (i.Dashboard, i.Sheet)))
            {
                sb.Append(GroupHead(g.Key.Dashboard, g.Key.Sheet, SheetUrl(g.First())));
                foreach (var i in g) sb.Append(Row(i, accent: "#009845", showDate: false));
            }
        }

        // ---- unanswered backlog ----
        if (r.Waiting.Count > 0)
        {
            sb.Append(SectionHead($"Still waiting for a reply ({r.Waiting.Count})"));
            foreach (var i in r.Waiting)
            {
                sb.Append(GroupHead(i.Dashboard, i.Sheet, SheetUrl(i)));
                sb.Append(Row(i, accent: "#dc2626", showDate: true));
            }
        }

        // ---- footer ----
        if (!string.IsNullOrEmpty(_inboxUrl))
        {
            sb.Append($"""
                <tr><td style="padding:6px 22px 22px;">
                  <table cellpadding="0" cellspacing="0" border="0"><tr>
                    <td bgcolor="#009845" style="background:#009845;border-radius:6px;">
                      <a href="{Esc(_inboxUrl)}" style="display:inline-block;padding:9px 18px;color:#ffffff;
                         font-size:13px;font-weight:600;text-decoration:none;">Open the team inbox</a>
                    </td>
                  </tr></table>
                </td></tr>
                """);
        }

        sb.Append("""
            <tr><td style="padding:0 22px 18px;font-size:11px;color:#9ca3af;">
              Sent by Qlik Collaboration. You receive this because you are listed on the BI team.
            </td></tr>
            </table></td></tr></table></body></html>
            """);
        return sb.ToString();
    }

    private static string Summary(DigestReport r)
    {
        if (r.New.Count == 0 && r.Waiting.Count > 0)
            return $"Nothing new — but {r.Waiting.Count} comment(s) still have no reply.";
        var bits = new List<string>();
        if (r.New.Count > 0) bits.Add($"{r.New.Count} new comment(s)");
        if (r.Waiting.Count > 0) bits.Add($"{r.Waiting.Count} still waiting for a reply");
        return bits.Count > 0 ? string.Join(" · ", bits) : "Nothing to report.";
    }

    private static string SectionHead(string text) => $"""
        <tr><td style="padding:18px 22px 2px;font-size:11px;font-weight:700;color:#6b7280;
                       text-transform:uppercase;letter-spacing:.6px;">{Esc(text)}</td></tr>
        """;

    private static string GroupHead(string dashboard, string sheet, string url)
    {
        var label = $"{Esc(dashboard)} <span style=\"color:#9ca3af;font-weight:400;\">› {Esc(sheet)}</span>";
        var link = string.IsNullOrEmpty(url)
            ? ""
            : $" <a href=\"{Esc(url)}\" style=\"color:#009845;font-size:11.5px;font-weight:400;" +
              "text-decoration:none;\">open&nbsp;in&nbsp;Qlik&nbsp;›</a>";
        return $"""
            <tr><td style="padding:12px 22px 4px;font-size:13px;font-weight:600;">{label}{link}</td></tr>
            """;
    }

    private string Row(DigestItem i, string accent, bool showDate)
    {
        var when = showDate
            ? i.CreatedAt.ToLocalTime().ToString("dd MMM HH:mm")
            : i.CreatedAt.ToLocalTime().ToString("HH:mm");
        var tag = i.IsReply
            ? "<span style=\"color:#9ca3af;font-size:11px;\"> reply</span>"
            : "";
        // A left border on the cell is the one accent Word renders reliably.
        return $"""
            <tr><td style="padding:0 22px 7px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                     style="border-left:3px solid {accent};background:#f9fafb;">
                <tr><td style="padding:8px 12px;">
                  <div style="font-size:12.5px;">
                    <b>{Esc(i.Author)}</b>{tag}
                    <span style="color:#9ca3af;font-size:11.5px;"> {Esc(when)}</span>
                  </div>
                  <div style="font-size:13px;padding-top:2px;color:#1f2937;">{Esc(Trim(i.Body))}</div>
                </td></tr>
              </table>
            </td></tr>
            """;
    }
}
