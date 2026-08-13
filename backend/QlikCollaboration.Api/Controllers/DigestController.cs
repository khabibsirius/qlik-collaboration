using Microsoft.AspNetCore.Mvc;
using QlikCollaboration.Api.Services;

namespace QlikCollaboration.Api.Controllers;

/// <summary>
/// Seeing and triggering the digest without waiting for the timer. Being able to look
/// at the exact e-mail before pointing it at a mail server is most of what makes this
/// safe to turn on.
/// </summary>
[ApiController]
[Route("api/digest")]
public class DigestController : ControllerBase
{
    private readonly DigestBuilder _builder;
    private readonly EmailDigestService _service;

    public DigestController(DigestBuilder builder, EmailDigestService service)
    {
        _builder = builder;
        _service = service;
    }

    /// <summary>The digest as it stands right now, rendered as the e-mail body.
    /// Open it in a browser; nothing is sent and nothing is recorded.</summary>
    [HttpGet("preview")]
    public async Task<ContentResult> Preview()
    {
        var report = await _builder.BuildAsync();
        var email = _service.BuildEmail();
        return Content(email.Html(report), "text/html; charset=utf-8");
    }

    /// <summary>The same digest as plain text, which is what the message body carries.</summary>
    [HttpGet("preview.txt")]
    public async Task<ContentResult> PreviewText()
    {
        var report = await _builder.BuildAsync();
        var email = _service.BuildEmail();
        return Content(email.Subject(report) + "\n\n" + email.PlainText(report), "text/plain; charset=utf-8");
    }

    /// <summary>What the next run would decide, without sending.</summary>
    [HttpGet("status")]
    public async Task<object> Status()
    {
        var report = await _builder.BuildAsync();
        return new
        {
            lastSent = report.Since,
            newItems = report.New.Count,
            waiting = report.Waiting.Count,
            wouldSend = !report.IsEmpty && report.New.Count > 0
        };
    }

    /// <summary>
    /// Send now. <c>force=true</c> ignores the "only when there is something new"
    /// rule so a configuration can be tested against an empty database.
    /// </summary>
    [HttpPost("send")]
    public async Task<IActionResult> Send([FromQuery] bool force = false)
    {
        try
        {
            return Ok(new { result = await _service.RunOnceAsync(HttpContext.RequestAborted, force) });
        }
        catch (Exception ex)
        {
            // The whole point of a manual trigger is to see why it failed.
            return StatusCode(500, new { error = ex.Message });
        }
    }
}
