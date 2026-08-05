using Dapper;
using Microsoft.AspNetCore.Mvc;
using Npgsql;
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

    public CommentsController(NpgsqlDataSource db) => _db = db;

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
        return await conn.QueryAsync<Comment>(sql, new { appId, sheetId, objectId });
    }

    public record CreateCommentDto(
        string AppId, string SheetId, string[]? ObjectIds, int? ParentId,
        string Author, string Body, string? SelectionState);

    [HttpPost]
    public async Task<ActionResult<Comment>> Create(CreateCommentDto dto)
    {
        if (string.IsNullOrWhiteSpace(dto.Body) || string.IsNullOrWhiteSpace(dto.Author))
            return BadRequest("Author and body are required.");

        await using var conn = await _db.OpenConnectionAsync();
        await using var tx = await conn.BeginTransactionAsync();

        var id = await conn.ExecuteScalarAsync<int>(
            @"INSERT INTO comments (app_id, sheet_id, parent_id, author, body, selection_state)
              VALUES (@AppId, @SheetId, @ParentId, @Author, @Body, @SelectionState::jsonb)
              RETURNING id", dto, tx);

        var objectIds = (dto.ObjectIds ?? []).Where(o => !string.IsNullOrWhiteSpace(o)).Distinct().ToArray();
        if (objectIds.Length > 0)
            await conn.ExecuteAsync(
                "INSERT INTO comment_objects (comment_id, object_id) VALUES (@id, @objectId)",
                objectIds.Select(o => new { id, objectId = o }), tx);

        await tx.CommitAsync();

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
        var affected = await conn.ExecuteAsync(
            @"UPDATE comments SET is_deleted = TRUE, updated_at = now()
              WHERE id = @id AND author = @author AND is_deleted = FALSE",
            new { id, author });
        return affected > 0 ? NoContent() : NotFound();
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
        return (await GetById(conn, id))!;
    }

    private static async Task<Comment?> GetById(NpgsqlConnection conn, int id) =>
        await conn.QuerySingleOrDefaultAsync<Comment>(
            SelectComment + " WHERE c.id = @id GROUP BY c.id", new { id });
}
