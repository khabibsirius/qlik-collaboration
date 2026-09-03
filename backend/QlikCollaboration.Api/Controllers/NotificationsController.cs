using Dapper;
using Microsoft.AspNetCore.Mvc;
using Npgsql;
using QlikCollaboration.Api.Services;

namespace QlikCollaboration.Api.Controllers;

[ApiController]
[Route("api/notifications")]
public class NotificationsController : ControllerBase
{
    private readonly NpgsqlDataSource _db;

    public NotificationsController(NpgsqlDataSource db) => _db = db;

    public class NotificationDto
    {
        public int Id { get; set; }
        public string Kind { get; set; } = "";       // comment | reply | status_change
        public bool IsRead { get; set; }
        public DateTime CreatedAt { get; set; }
        public int CommentId { get; set; }
        public string FromAuthor { get; set; } = ""; // who wrote the triggering comment
        public string Excerpt { get; set; } = "";
        public string AppId { get; set; } = "";
        public string SheetId { get; set; } = "";
    }

    /// <summary>
    /// Latest 50 notifications for a user, newest first — filtered to the comments
    /// that user may read <b>now</b>.
    ///
    /// Visibility is applied here, at read time, rather than trusted from the moment
    /// the row was written. A notification carries an 80-character excerpt of the
    /// comment, so a sheet that was public when someone commented and is private
    /// again today would otherwise keep handing that text out through the bell: the
    /// discussion disappears from the panel while its history stays legible in the
    /// notification list. Re-deciding on every read makes the switch mean the same
    /// thing in both places, in both directions — turning a sheet public also reveals
    /// the notifications that were hidden while it was not.
    /// </summary>
    [HttpGet]
    public async Task<IEnumerable<NotificationDto>> Get([FromQuery] string user)
    {
        if (string.IsNullOrWhiteSpace(user)) return [];

        await using var conn = await _db.OpenConnectionAsync();
        var isTeam = UserRoles.SeesEverything(await UserRoles.Of(conn, user));

        return await conn.QueryAsync<NotificationDto>(
            @"SELECT n.id, n.kind, n.is_read, n.created_at, n.comment_id,
                     c.author AS from_author, left(c.body, 80) AS excerpt,
                     c.app_id, c.sheet_id
              FROM notifications n
              -- skip notifications whose comment was deleted: clicking one would
              -- navigate the user to a sheet where there is nothing to show
              JOIN comments c ON c.id = n.comment_id AND c.is_deleted = FALSE
              -- the thread's author, which is who a reply belongs to
              LEFT JOIN comments p ON p.id = c.parent_id
              WHERE n.username = @user
                AND (" + Visibility.IsPublicSql + @"
                     OR @isTeam
                     OR lower(COALESCE(p.author, c.author)) = lower(@user))
              ORDER BY n.created_at DESC
              LIMIT 50", new { user = user.Trim(), isTeam });
    }

    /// <summary>Mark all of a user's notifications as read.</summary>
    [HttpPut("read")]
    public async Task<IActionResult> MarkRead([FromQuery] string user)
    {
        await using var conn = await _db.OpenConnectionAsync();
        await conn.ExecuteAsync(
            "UPDATE notifications SET is_read = TRUE WHERE username = @user AND is_read = FALSE",
            new { user });
        return NoContent();
    }

    /// <summary>Mark one notification as read (when the user opens it).
    /// Scoped by username so one user cannot clear another's notifications.</summary>
    [HttpPut("{id:int}/read")]
    public async Task<IActionResult> MarkOneRead(int id, [FromQuery] string user)
    {
        await using var conn = await _db.OpenConnectionAsync();
        var affected = await conn.ExecuteAsync(
            "UPDATE notifications SET is_read = TRUE WHERE id = @id AND username = @user",
            new { id, user });
        return affected > 0 ? NoContent() : NotFound();
    }
}
