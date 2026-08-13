using Dapper;
using Microsoft.AspNetCore.Mvc;
using Npgsql;

namespace QlikCollaboration.Api.Controllers;

/// <summary>
/// The team's work queue. The comments API answers "what was said on this sheet",
/// which means feedback is only discovered by opening the sheet it was left on —
/// a comment on a dashboard nobody opens that week goes unseen. This answers the
/// question the team actually has: what has been said, anywhere, that we have not
/// dealt with yet.
/// </summary>
[ApiController]
[Route("api/inbox")]
public class InboxController : ControllerBase
{
    private readonly NpgsqlDataSource _db;

    public InboxController(NpgsqlDataSource db) => _db = db;

    public class InboxItem
    {
        public int Id { get; set; }
        public string AppId { get; set; } = "";
        public string SheetId { get; set; } = "";
        /// <summary>Dashboard title; null on rows written before titles were captured.</summary>
        public string? AppName { get; set; }
        public string? SheetName { get; set; }
        public string Author { get; set; } = "";
        public string Body { get; set; } = "";
        public string Status { get; set; } = "new";
        public DateTime CreatedAt { get; set; }
        /// <summary>0 means nobody on the team has answered yet — the signal the queue exists for.</summary>
        public int ReplyCount { get; set; }
        /// <summary>Newest activity in the thread, so a thread rises when it is replied to.</summary>
        public DateTime LastActivityAt { get; set; }
    }

    /// <summary>
    /// Open threads across every app, newest activity first. Replies are folded into
    /// their parent rather than listed separately: the unit of work is the thread.
    /// </summary>
    [HttpGet]
    public async Task<IEnumerable<InboxItem>> Get([FromQuery] bool includeClosed = false)
    {
        await using var conn = await _db.OpenConnectionAsync();
        return await conn.QueryAsync<InboxItem>(
            @"SELECT c.id, c.app_id, c.sheet_id, c.app_name, c.sheet_name,
                     c.author, c.body, c.status, c.created_at,
                     COUNT(r.id) AS reply_count,
                     GREATEST(c.created_at, COALESCE(MAX(r.created_at), c.created_at)) AS last_activity_at
              FROM comments c
              LEFT JOIN comments r ON r.parent_id = c.id AND r.is_deleted = FALSE
              WHERE c.parent_id IS NULL
                AND c.is_deleted = FALSE
                AND (@includeClosed OR c.status <> 'closed')
              GROUP BY c.id
              ORDER BY last_activity_at DESC
              LIMIT 200", new { includeClosed });
    }

    /// <summary>Replies of one thread, oldest first — fetched when a row is expanded.</summary>
    [HttpGet("{id:int}/replies")]
    public async Task<IEnumerable<InboxItem>> Replies(int id)
    {
        await using var conn = await _db.OpenConnectionAsync();
        return await conn.QueryAsync<InboxItem>(
            @"SELECT id, app_id, sheet_id, app_name, sheet_name, author, body, status,
                     created_at, 0 AS reply_count, created_at AS last_activity_at
              FROM comments
              WHERE parent_id = @id AND is_deleted = FALSE
              ORDER BY created_at", new { id });
    }
}
