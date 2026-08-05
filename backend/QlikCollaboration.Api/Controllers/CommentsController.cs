using Dapper;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Npgsql;
using QlikCollaboration.Api.Hubs;
using QlikCollaboration.Api.Models;

namespace QlikCollaboration.Api.Controllers;

[ApiController]
[Route("api/comments")]
public class CommentsController : ControllerBase
{
    // object_ids is aggregated from the comment_objects junction table
    private const string SelectComment =
        @"SELECT c.id, c.app_id, c.sheet_id, c.parent_id, c.author, c.body,
                 c.selection_state, c.status, c.is_deleted, c.created_at, c.updated_at,
                 COALESCE(array_agg(co.object_id) FILTER (WHERE co.object_id IS NOT NULL), '{}') AS object_ids
          FROM comments c
          LEFT JOIN comment_objects co ON co.comment_id = c.id";

    private readonly NpgsqlDataSource _db;
    private readonly IHubContext<CommentsHub> _hub;

    public CommentsController(NpgsqlDataSource db, IHubContext<CommentsHub> hub)
    {
        _db = db;
        _hub = hub;
    }

    private Task Broadcast(string appId, string sheetId) =>
        _hub.Clients.All.SendAsync("commentsChanged", new { appId, sheetId });

    private Task NotifyUser(string username) =>
        _hub.Clients.All.SendAsync("notify", new { username });

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

    /// <summary>All comments (incl. replies) for a sheet, oldest first.
    /// Optional objectId returns only comments attached to that object.</summary>
    [HttpGet]
    public async Task<IEnumerable<Comment>> Get(
        [FromQuery] string appId, [FromQuery] string sheetId, [FromQuery] string? objectId = null)
    {
        await using var conn = await _db.OpenConnectionAsync();
        var sql = SelectComment +
                  " WHERE c.app_id = @appId AND c.sheet_id = @sheetId AND c.is_deleted = FALSE" +
                  (objectId is not null
                      ? @" AND EXISTS (SELECT 1 FROM comment_objects x
                                       WHERE x.comment_id = c.id AND x.object_id = @objectId)"
                      : "") +
                  " GROUP BY c.id ORDER BY c.created_at";
        var comments = (await conn.QueryAsync<Comment>(sql, new { appId, sheetId, objectId })).ToList();
        await AttachFiles(conn, comments);
        return comments;
    }

    public record CreateCommentDto(
        string AppId, string SheetId, string[]? ObjectIds, int? ParentId,
        string Author, string Body, string? SelectionState);

    [HttpPost]
    public async Task<ActionResult<Comment>> Create(CreateCommentDto dto)
    {
        if (string.IsNullOrWhiteSpace(dto.Body) || string.IsNullOrWhiteSpace(dto.Author))
            return BadRequest("Author and body are required.");

        var author = dto.Author.Trim();

        await using var conn = await _db.OpenConnectionAsync();
        await using var tx = await conn.BeginTransactionAsync();

        // Etap 2: users self-register by commenting (Desktop has no auth;
        // on Enterprise this becomes the authenticated identity).
        await conn.ExecuteAsync(
            @"INSERT INTO users (username, display_name) VALUES (@author, @author)
              ON CONFLICT (username) DO NOTHING", new { author }, tx);

        var id = await conn.ExecuteScalarAsync<int>(
            @"INSERT INTO comments (app_id, sheet_id, parent_id, author, body, selection_state)
              VALUES (@AppId, @SheetId, @ParentId, @Author, @Body, @SelectionState::jsonb)
              RETURNING id", dto, tx);

        var objectIds = (dto.ObjectIds ?? []).Where(o => !string.IsNullOrWhiteSpace(o)).Distinct().ToArray();
        if (objectIds.Length > 0)
            await conn.ExecuteAsync(
                "INSERT INTO comment_objects (comment_id, object_id) VALUES (@id, @objectId)",
                objectIds.Select(o => new { id, objectId = o }), tx);

        // Etap 2: @mentions — match "@username" against known users (longest first,
        // so "@Ivan Petrov" wins over "@Ivan" when both exist).
        var usernames = (await conn.QueryAsync<string>("SELECT username FROM users", transaction: tx)).ToList();
        var mentioned = usernames
            .Where(u => !u.Equals(author, StringComparison.OrdinalIgnoreCase))
            .Where(u => dto.Body.Contains("@" + u, StringComparison.OrdinalIgnoreCase))
            .Distinct()
            .ToList();

        var toNotify = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var u in mentioned)
        {
            await conn.ExecuteAsync(
                "INSERT INTO mentions (comment_id, mentioned_username) VALUES (@id, @u)", new { id, u }, tx);
            await conn.ExecuteAsync(
                "INSERT INTO notifications (username, comment_id, kind) VALUES (@u, @id, 'mention')", new { id, u }, tx);
            toNotify.Add(u);
        }

        // reply → notify the parent comment's author (unless it's themselves or already mentioned)
        if (dto.ParentId is int parentId)
        {
            var parentAuthor = await conn.ExecuteScalarAsync<string?>(
                "SELECT author FROM comments WHERE id = @parentId", new { parentId }, tx);
            if (parentAuthor is not null &&
                !parentAuthor.Equals(author, StringComparison.OrdinalIgnoreCase) &&
                !toNotify.Contains(parentAuthor))
            {
                await conn.ExecuteAsync(
                    "INSERT INTO notifications (username, comment_id, kind) VALUES (@parentAuthor, @id, 'reply')",
                    new { parentAuthor, id }, tx);
                toNotify.Add(parentAuthor);
            }
        }

        await tx.CommitAsync();

        await Broadcast(dto.AppId, dto.SheetId);
        foreach (var u in toNotify) await NotifyUser(u);

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
        var row = await conn.QuerySingleOrDefaultAsync<(string AppId, string SheetId)?>(
            @"UPDATE comments SET is_deleted = TRUE, updated_at = now()
              WHERE id = @id AND author = @author AND is_deleted = FALSE
              RETURNING app_id, sheet_id",
            new { id, author });
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
