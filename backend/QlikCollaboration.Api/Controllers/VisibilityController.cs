using Dapper;
using Microsoft.AspNetCore.Mvc;
using Npgsql;
using QlikCollaboration.Api.Services;

namespace QlikCollaboration.Api.Controllers;

/// <summary>
/// The public/private switch for a discussion, per app and per sheet.
///
/// Reading the effective value is open — the panel needs it on every load to know
/// whether to offer the @ button — but changing it is an admin action, for the same
/// reason granting a role is: it decides who can read whose feedback.
/// </summary>
[ApiController]
[Route("api/visibility")]
public class VisibilityController : ControllerBase
{
    private readonly NpgsqlDataSource _db;

    public VisibilityController(NpgsqlDataSource db) => _db = db;

    public class SheetVisibilityDto
    {
        public string SheetId { get; set; } = "";
        public string? SheetName { get; set; }
        public long Comments { get; set; }
        /// <summary>"inherit" (no row of its own), "public" or "private".</summary>
        public string Setting { get; set; } = "inherit";
        /// <summary>What actually applies here once the app-wide value is taken into account.</summary>
        public bool Effective { get; set; }
        public string? SetBy { get; set; }
        public DateTime? SetAt { get; set; }
    }

    public class AppVisibilityDto
    {
        public string AppId { get; set; } = "";
        public string? AppName { get; set; }
        public long Comments { get; set; }
        /// <summary>"default" (never set, so private), "public" or "private".</summary>
        public string Setting { get; set; } = "default";
        public bool Effective { get; set; }
        public string? SetBy { get; set; }
        public DateTime? SetAt { get; set; }
        public List<SheetVisibilityDto> Sheets { get; set; } = [];
    }

    private class CommentedPlace
    {
        public string AppId { get; set; } = "";
        public string SheetId { get; set; } = "";
        public string? AppName { get; set; }
        public string? SheetName { get; set; }
        public long Comments { get; set; }
    }

    private class StoredSetting
    {
        public string AppId { get; set; } = "";
        public string SheetId { get; set; } = "";
        public bool IsPublic { get; set; }
        public string SetBy { get; set; } = "";
        public DateTime SetAt { get; set; }
    }

    /// <summary>
    /// Every app and sheet people are actually commenting on, with the setting that
    /// governs it — not merely the rows that happen to have been configured. An admin
    /// asked to make a dashboard public needs to find it in this list; a screen that
    /// showed only what was already set would be empty exactly when it is first needed.
    ///
    /// Sheets that have no row of their own report "inherit", so the screen can say
    /// what is in force without repeating the app's answer as if it were their own.
    /// </summary>
    [HttpGet]
    public async Task<IEnumerable<AppVisibilityDto>> Get()
    {
        await using var conn = await _db.OpenConnectionAsync();

        // max() over a group picks any non-null title the extension has reported for
        // that app or sheet; rows written before titles were captured hold null and
        // lose to one that has it.
        var places = (await conn.QueryAsync<CommentedPlace>(
            @"SELECT c.app_id, c.sheet_id,
                     max(c.app_name) AS app_name, max(c.sheet_name) AS sheet_name,
                     count(*) AS comments
              FROM comments c
              WHERE c.is_deleted = FALSE
              GROUP BY c.app_id, c.sheet_id")).ToList();

        var stored = (await conn.QueryAsync<StoredSetting>(
            "SELECT app_id, sheet_id, is_public, set_by, set_at FROM comment_visibility")).ToList();

        // An app that has a setting but no comments yet still belongs on the screen —
        // otherwise turning a brand-new dashboard public would silently vanish from it.
        var appIds = places.Select(p => p.AppId)
            .Concat(stored.Select(v => v.AppId))
            .Distinct(StringComparer.Ordinal)
            .ToList();

        var result = new List<AppVisibilityDto>();
        foreach (var appId in appIds)
        {
            var appRow = stored.FirstOrDefault(v => v.AppId == appId && v.SheetId == Visibility.AppWide);
            var appPlaces = places.Where(p => p.AppId == appId).ToList();

            var app = new AppVisibilityDto
            {
                AppId = appId,
                AppName = appPlaces.Select(p => p.AppName).FirstOrDefault(n => n is not null),
                Comments = appPlaces.Sum(p => p.Comments),
                Setting = appRow is null ? "default" : appRow.IsPublic ? "public" : "private",
                Effective = appRow?.IsPublic ?? false,
                SetBy = appRow?.SetBy,
                SetAt = appRow?.SetAt
            };

            var sheetIds = appPlaces.Select(p => p.SheetId)
                .Concat(stored.Where(v => v.AppId == appId && v.SheetId != Visibility.AppWide)
                              .Select(v => v.SheetId))
                .Distinct(StringComparer.Ordinal)
                .ToList();

            foreach (var sheetId in sheetIds)
            {
                var sheetRow = stored.FirstOrDefault(v => v.AppId == appId && v.SheetId == sheetId);
                var place = appPlaces.FirstOrDefault(p => p.SheetId == sheetId);
                app.Sheets.Add(new SheetVisibilityDto
                {
                    SheetId = sheetId,
                    SheetName = place?.SheetName,
                    Comments = place?.Comments ?? 0,
                    Setting = sheetRow is null ? "inherit" : sheetRow.IsPublic ? "public" : "private",
                    Effective = sheetRow?.IsPublic ?? app.Effective,
                    SetBy = sheetRow?.SetBy,
                    SetAt = sheetRow?.SetAt
                });
            }

            app.Sheets = app.Sheets
                .OrderByDescending(x => x.Comments)
                .ThenBy(x => x.SheetName ?? x.SheetId, StringComparer.OrdinalIgnoreCase)
                .ToList();
            result.Add(app);
        }

        return result
            .OrderByDescending(a => a.Comments)
            .ThenBy(a => a.AppName ?? a.AppId, StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>
    /// What actually applies to one sheet, and which level decided it. The panel calls
    /// this on load; no role is needed, because the answer is already obvious to
    /// anyone who can see whether other people's comments are on their screen.
    /// </summary>
    [HttpGet("resolve")]
    public async Task<IActionResult> Resolve([FromQuery] string appId, [FromQuery] string sheetId)
    {
        if (string.IsNullOrWhiteSpace(appId)) return BadRequest(new { error = "appId is required." });

        await using var conn = await _db.OpenConnectionAsync();
        var resolved = await Visibility.ResolveAsync(conn, appId, sheetId ?? "");
        return Ok(new { isPublic = resolved.IsPublic, source = resolved.Source });
    }

    public record SetVisibilityDto(string AppId, string? SheetId, bool IsPublic, string By);

    /// <summary>
    /// Turn a discussion public or private. Omit <c>SheetId</c> to set the app-wide
    /// default; give one to override a single sheet inside it.
    /// </summary>
    [HttpPut]
    public async Task<IActionResult> Set(SetVisibilityDto dto)
    {
        if (string.IsNullOrWhiteSpace(dto.AppId)) return BadRequest(new { error = "appId is required." });

        await using var conn = await _db.OpenConnectionAsync();
        if (!UserRoles.CanModerate(await UserRoles.Of(conn, dto.By)))
            return StatusCode(403, new { error = "Only an admin can change who may read a discussion." });

        await Visibility.SetAsync(conn, dto.AppId.Trim(), dto.SheetId?.Trim(), dto.IsPublic, dto.By.Trim());
        return NoContent();
    }

    /// <summary>
    /// Remove a setting so the level above decides again: clearing a sheet returns it
    /// to its app's default, clearing an app returns it to private.
    /// </summary>
    [HttpDelete]
    public async Task<IActionResult> Clear(
        [FromQuery] string appId, [FromQuery] string? sheetId, [FromQuery] string by)
    {
        if (string.IsNullOrWhiteSpace(appId)) return BadRequest(new { error = "appId is required." });

        await using var conn = await _db.OpenConnectionAsync();
        if (!UserRoles.CanModerate(await UserRoles.Of(conn, by)))
            return StatusCode(403, new { error = "Only an admin can change who may read a discussion." });

        return await Visibility.ClearAsync(conn, appId.Trim(), sheetId?.Trim())
            ? NoContent()
            : NotFound(new { error = "Nothing was set at that level." });
    }
}
