using Dapper;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Npgsql;
using QlikCollaboration.Api.Hubs;
using QlikCollaboration.Api.Models;

namespace QlikCollaboration.Api.Controllers;

/// <summary>Etap 3: file attachments. Files live on disk (configurable folder),
/// metadata in PostgreSQL. Voice messages are just audio attachments.</summary>
[ApiController]
public class AttachmentsController : ControllerBase
{
    private const long MaxBytes = 25 * 1024 * 1024; // 25 MB

    // Allowlist — bank-friendly: documents, images, audio (voice messages), archives.
    private static readonly HashSet<string> AllowedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".pdf", ".xlsx", ".xls", ".docx", ".doc", ".pptx", ".csv", ".txt",
        ".png", ".jpg", ".jpeg", ".gif",
        ".webm", ".ogg", ".mp3", ".m4a", ".wav",
        ".zip"
    };

    private readonly NpgsqlDataSource _db;
    private readonly IHubContext<CommentsHub> _hub;
    private readonly string _storageDir;

    public AttachmentsController(NpgsqlDataSource db, IHubContext<CommentsHub> hub,
        IConfiguration config, IWebHostEnvironment env)
    {
        _db = db;
        _hub = hub;
        var configured = config["Storage:AttachmentsPath"];
        _storageDir = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(env.ContentRootPath, "uploads")
            : configured;
    }

    [HttpPost("api/comments/{commentId:int}/attachments")]
    [RequestSizeLimit(MaxBytes)]
    public async Task<ActionResult<Attachment>> Upload(int commentId, IFormFile file)
    {
        if (file is null || file.Length == 0) return BadRequest("Empty file.");
        if (file.Length > MaxBytes) return BadRequest("File too large (max 25 MB).");

        var ext = Path.GetExtension(file.FileName);
        if (!AllowedExtensions.Contains(ext))
            return BadRequest($"File type '{ext}' is not allowed.");

        await using var conn = await _db.OpenConnectionAsync();
        var comment = await conn.QuerySingleOrDefaultAsync<(string AppId, string SheetId)?>(
            "SELECT app_id, sheet_id FROM comments WHERE id = @commentId AND is_deleted = FALSE",
            new { commentId });
        if (comment is null) return NotFound("Comment not found.");

        Directory.CreateDirectory(_storageDir);
        var storedName = $"{Guid.NewGuid():N}{ext.ToLowerInvariant()}";
        var fullPath = Path.Combine(_storageDir, storedName);
        await using (var stream = System.IO.File.Create(fullPath))
            await file.CopyToAsync(stream);

        var created = await conn.QuerySingleAsync<Attachment>(
            @"INSERT INTO attachments (comment_id, file_name, content_type, size_bytes, storage_path)
              VALUES (@commentId, @fileName, @contentType, @sizeBytes, @storedName)
              RETURNING id, comment_id, file_name, content_type, size_bytes, uploaded_at",
            new
            {
                commentId,
                fileName = Path.GetFileName(file.FileName),
                contentType = string.IsNullOrWhiteSpace(file.ContentType)
                    ? "application/octet-stream" : file.ContentType,
                sizeBytes = file.Length,
                storedName
            });

        await _hub.Clients.All.SendAsync("commentsChanged",
            new { appId = comment.Value.AppId, sheetId = comment.Value.SheetId });

        return Created($"/api/attachments/{created.Id}", created);
    }

    [HttpGet("api/attachments/{id:int}")]
    public async Task<IActionResult> Download(int id)
    {
        await using var conn = await _db.OpenConnectionAsync();
        var row = await conn.QuerySingleOrDefaultAsync<(string FileName, string ContentType, string StoragePath)?>(
            "SELECT file_name, content_type, storage_path FROM attachments WHERE id = @id", new { id });
        if (row is null) return NotFound();

        var fullPath = Path.Combine(_storageDir, row.Value.StoragePath);
        if (!System.IO.File.Exists(fullPath)) return NotFound("File missing from storage.");

        // enableRangeProcessing lets <audio>/<img> stream and seek
        return PhysicalFile(fullPath, row.Value.ContentType, row.Value.FileName, enableRangeProcessing: true);
    }
}
