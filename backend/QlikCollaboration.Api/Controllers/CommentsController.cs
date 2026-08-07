using Dapper;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Npgsql;
using QlikCollaboration.Api.Hubs;
using QlikCollaboration.Api.Models;
using QlikCollaboration.Api.Services;

namespace QlikCollaboration.Api.Controllers;

[ApiController]
[Route("api/comments")]
public class CommentsController : ControllerBase
{
    // object_ids is aggregated from the comment_objects junction table
    // The join to the parent is what makes a thread the unit of visibility: a reply
    // belongs to whoever started the thread, not to whoever wrote the reply. Joining
    // on a primary key adds no rows, so the object_ids aggregate is unaffected.
    private const string SelectComment =
        @"SELECT c.id, c.app_id, c.sheet_id, c.app_name, c.sheet_name, c.parent_id, c.author, c.body,
                 c.selection_state, c.status, c.is_deleted, c.created_at, c.updated_at,
                 COALESCE(array_agg(co.object_id) FILTER (WHERE co.object_id IS NOT NULL), '{}') AS object_ids
          FROM comments c
          LEFT JOIN comment_objects co ON co.comment_id = c.id
          LEFT JOIN comments p ON p.id = c.parent_id";

    private readonly NpgsqlDataSource _db;
    private readonly IHubContext<CommentsHub> _hub;

    public CommentsController(NpgsqlDataSource db, IHubContext<CommentsHub> hub)
    {
        _db = db;
        _hub = hub;
    }

    private Task Broadcast(string appId, string sheetId) =>
        _hub.Clients.All.SendAsync("commentsChanged", new { appId, sheetId });

    /// <summary>One message listing everyone notified — a broadcast to the whole
    /// team would otherwise mean N messages to N clients.</summary>
    private Task NotifyUsers(IReadOnlyCollection<string> usernames) =>
        usernames.Count == 0
            ? Task.CompletedTask
            : _hub.Clients.All.SendAsync("notify", new { usernames });

    private static async Task AttachFiles(NpgsqlConnection conn, List<Comment> comments)
    {
        if (comments.Count == 0) return;
        var ids = comments.Select(c => c.Id).ToArray();
        var files = await conn.QueryAsync<Attachment>(
            @"SELECT id, comment_id, file_name, content_type, size_bytes, uploaded_at
              FROM attachments WHERE comment_id = ANY(@ids) ORDER BY id", new { ids });
        var byComment = files.GroupBy(f => f.CommentId).ToDictionary(g => g.Key, g => g.ToList());
        foreach (var c in comments)
            if (byComment.TryGetValue(c.Id, out var list)) c.Attachments = list;
    }

    /// <summary>
    /// Comments for a sheet, oldest first, filtered to what <paramref name="user"/>
    /// may see: the BI team sees every thread, anyone else sees only the threads they
    /// started — so two executives never read each other's feedback.
    ///
    /// Filtering happens here rather than in the panel because a client-side filter
    /// would still have sent every comment over the wire. It is not a security
    /// boundary: like the rest of this API it trusts the username it is given
    /// (see docs/Enterprise.md), so it prevents disclosure by the UI, not by a
    /// determined caller. Real enforcement needs the JWT work listed there.
    ///
    /// Optional objectId returns only comments attached to that object.
    /// </summary>
    [HttpGet]
    public async Task<IEnumerable<Comment>> Get(
        [FromQuery] string appId, [FromQuery] string sheetId,
        [FromQuery] string? user = null, [FromQuery] string? objectId = null)
    {
        // No identity yet — the panel asks before it has resolved who you are. Showing
        // everything "just until it knows" would leak exactly what this filter exists
        // to prevent, so show nothing and let the panel ask again a moment later.
        if (string.IsNullOrWhiteSpace(user)) return [];

        await using var conn = await _db.OpenConnectionAsync();
        var isTeam = UserRoles.SeesEverything(await UserRoles.Of(conn, user));
        var sql = SelectComment +
                  " WHERE c.app_id = @appId AND c.sheet_id = @sheetId AND c.is_deleted = FALSE" +
                  // COALESCE picks the thread's author: the parent's for a reply,
                  // the comment's own for a root comment.
                  " AND (@isTeam OR lower(COALESCE(p.author, c.author)) = lower(@user))" +
                  (objectId is not null
                      ? @" AND EXISTS (SELECT 1 FROM comment_objects x
                                       WHERE x.comment_id = c.id AND x.object_id = @objectId)"
                      : "") +
                  " GROUP BY c.id ORDER BY c.created_at";
        var comments = (await conn.QueryAsync<Comment>(
            sql, new { appId, sheetId, objectId, user = user.Trim(), isTeam })).ToList();
        await AttachFiles(conn, comments);
        return comments;
    }

    public record CreateCommentDto(
        string AppId, string SheetId, string[]? ObjectIds, int? ParentId,
        string Author, string Body, string? SelectionState,
        /// <summary>Qlik UserDirectory of the author ('BANK' on Enterprise) — audit only.</summary>
        string? AuthorDirectory = null,
        /// <summary>Qlik app title, so the inbox can name the dashboard instead of its id.</summary>
        string? AppName = null,
        /// <summary>Qlik sheet title, same reason.</summary>
        string? SheetName = null);

    [HttpPost]
    public async Task<ActionResult<Comment>> Create(CreateCommentDto dto)
    {
        if (string.IsNullOrWhiteSpace(dto.Body) || string.IsNullOrWhiteSpace(dto.Author))
            return BadRequest("Author and body are required.");

        var author = dto.Author.Trim();

        await using var conn = await _db.OpenConnectionAsync();
        await using var tx = await conn.BeginTransactionAsync();

        // Etap 2: users self-register by commenting. On Enterprise the extension
        // sends the Qlik-authenticated identity (AD via Qlik Proxy); on Desktop
        // it is a typed name. The directory is recorded for audit and refreshed
        // if a user who first appeared manually later arrives authenticated.
        await UserRoles.EnsureUser(conn, author,
            string.IsNullOrWhiteSpace(dto.AuthorDirectory) ? null : dto.AuthorDirectory.Trim(), tx);

        var id = await conn.ExecuteScalarAsync<int>(
            @"INSERT INTO comments (app_id, sheet_id, app_name, sheet_name,
                                    parent_id, author, body, selection_state)
              VALUES (@AppId, @SheetId, @AppName, @SheetName,
                      @ParentId, @Author, @Body, @SelectionState::jsonb)
              RETURNING id", dto, tx);

        var objectIds = (dto.ObjectIds ?? []).Where(o => !string.IsNullOrWhiteSpace(o)).Distinct().ToArray();
        if (objectIds.Length > 0)
            await conn.ExecuteAsync(
                "INSERT INTO comment_objects (comment_id, object_id) VALUES (@id, @objectId)",
                objectIds.Select(o => new { id, objectId = o }), tx);

        // Notify exactly the people who are allowed to read this thread — the BI team,
        // plus the person who started it. Notifying every registered user would tell
        // one executive that another had commented, and the excerpt in the
        // notification would say what about.
        //
        // Replies are one level deep (see schema.sql), so a reply's parent is always
        // the root: the parent's author IS the thread's author.
        var parentAuthor = dto.ParentId is int parentId
            ? await conn.ExecuteScalarAsync<string?>(
                "SELECT author FROM comments WHERE id = @parentId", new { parentId }, tx)
            : null;
        var threadAuthor = parentAuthor ?? author;

        // The comparer collapses case-variant duplicates ("ivanov" / "Ivanov") into a
        // single notification, and makes the self-removal below case-insensitive too.
        var toNotify = new HashSet<string>(
            await UserRoles.NotifyAudience(conn, tx), StringComparer.OrdinalIgnoreCase);
        toNotify.Add(threadAuthor);
        toNotify.Remove(author);            // never notify yourself about your own comment

        foreach (var u in toNotify)
        {
            var kind = u.Equals(threadAuthor, StringComparison.OrdinalIgnoreCase) ? "reply" : "comment";
            await conn.ExecuteAsync(
                "INSERT INTO notifications (username, comment_id, kind) VALUES (@u, @id, @kind)",
                new { id, u, kind }, tx);
        }

        await tx.CommitAsync();

        await Broadcast(dto.AppId, dto.SheetId);
        await NotifyUsers(toNotify.ToList());

        var created = await GetById(conn, id);
        return CreatedAtAction(nameof(Get), new { appId = created!.AppId, sheetId = created.SheetId }, created);
    }

    /// <summary>
    /// Soft delete. On Desktop there is no auth, so ownership is checked by author
    /// name (trust model of a single-user machine). On Enterprise this becomes the
    /// authenticated identity from JWT.
    /// </summary>
    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id, [FromQuery] string author)
    {
        await using var conn = await _db.OpenConnectionAsync();

        // Your own comment, always. Anyone's comment if you are an admin — which is the
        // whole point of the role: a thread left by someone who has since left, or a
        // comment posted on the wrong dashboard, otherwise stays there for good.
        var isAdmin = UserRoles.CanModerate(await UserRoles.Of(conn, author));

        var row = await conn.QuerySingleOrDefaultAsync<(string AppId, string SheetId)?>(
            @"UPDATE comments SET is_deleted = TRUE, updated_at = now()
              WHERE id = @id AND is_deleted = FALSE
                AND (@isAdmin OR lower(author) = lower(@author))
              RETURNING app_id, sheet_id",
            new { id, author, isAdmin });
        if (row is null) return NotFound();
        await Broadcast(row.Value.AppId, row.Value.SheetId);
        return NoContent();
    }

    public record UpdateStatusDto(string Status);

    /// <summary>Etap 4: workflow status (new / in_progress / fixed / closed).</summary>
    [HttpPut("{id:int}/status")]
    public async Task<ActionResult<Comment>> UpdateStatus(int id, UpdateStatusDto dto)
    {
        string[] allowed = ["new", "in_progress", "fixed", "closed"];
        if (!allowed.Contains(dto.Status))
            return BadRequest($"Status must be one of: {string.Join(", ", allowed)}");

        await using var conn = await _db.OpenConnectionAsync();
        var affected = await conn.ExecuteAsync(
            @"UPDATE comments SET status = @Status, updated_at = now()
              WHERE id = @id AND is_deleted = FALSE", new { id, dto.Status });
        if (affected == 0) return NotFound();
        var updated = (await GetById(conn, id))!;
        await Broadcast(updated.AppId, updated.SheetId);
        return updated;
    }

    private static async Task<Comment?> GetById(NpgsqlConnection conn, int id)
    {
        var comment = await conn.QuerySingleOrDefaultAsync<Comment>(
            SelectComment + " WHERE c.id = @id GROUP BY c.id", new { id });
        if (comment is not null) await AttachFiles(conn, [comment]);
        return comment;
    }
}
