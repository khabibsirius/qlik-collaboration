using System.Reflection;
using Dapper;
using Microsoft.AspNetCore.Mvc;
using Npgsql;
using QlikCollaboration.Api.Services;

namespace QlikCollaboration.Api.Controllers;

/// <summary>
/// One page that answers "what is actually deployed and what state is the database
/// in". Every support round trip so far has been spent establishing those two things
/// — a stale image, a database behind the build, a missing index — one question at a
/// time. This reports all of it at once, and is safe to read: no comment text, no
/// credentials, only shapes and counts.
/// </summary>
[ApiController]
[Route("api/diagnostics")]
public class DiagnosticsController : ControllerBase
{
    private readonly NpgsqlDataSource _db;
    private readonly IConfiguration _config;

    public DiagnosticsController(NpgsqlDataSource db, IConfiguration config)
    {
        _db = db;
        _config = config;
    }

    [HttpGet]
    public async Task<IActionResult> Get()
    {
        var asm = Assembly.GetExecutingAssembly();
        var built = System.IO.File.GetLastWriteTimeUtc(asm.Location);

        object database;
        try
        {
            await using var conn = await _db.OpenConnectionAsync();

            var missing = await SchemaGuard.MissingAsync(conn);
            var duplicates = await SchemaGuard.DuplicateNamesAsync(conn);

            var indexes = await conn.QueryAsync<string>(
                "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname");
            var roles = await conn.QueryAsync<(string Role, long Count)>(
                "SELECT role, count(*) FROM users GROUP BY role ORDER BY role");

            database = new
            {
                reachable = true,
                server = await conn.ExecuteScalarAsync<string>("SHOW server_version"),
                schemaUpToDate = missing.Count == 0,
                missing,
                // the pair that blocks the unique index, and with it role certainty
                duplicateUsernames = duplicates,
                indexes = indexes.ToArray(),
                users = roles.ToDictionary(r => r.Role, r => r.Count),
                comments = await conn.ExecuteScalarAsync<long>(
                    "SELECT count(*) FROM comments WHERE is_deleted = FALSE"),
                notifications = await conn.ExecuteScalarAsync<long>("SELECT count(*) FROM notifications")
            };
        }
        catch (Exception ex)
        {
            database = new { reachable = false, error = ex.Message };
        }

        return Ok(new
        {
            api = new
            {
                version = asm.GetName().Version?.ToString(),
                builtUtc = built,
                // the question behind every "did the rebuild take?"
                ageOfBuild = (DateTime.UtcNow - built).ToString(@"d\d\ hh\h\ mm\m"),
                environment = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") ?? "Production"
            },
            database,
            config = new
            {
                cors = _config.GetSection("Cors:AllowedOrigins").Get<string[]>() ?? [],
                qlikBaseUrl = _config["Qlik:BaseUrl"] ?? "",
                applySchemaOnStart = _config.GetValue("Database:ApplySchemaOnStart", false),
                seedAdmins = _config.GetSection("Team:Admins").Get<string[]>() ?? [],
                seedMembers = _config.GetSection("Team:Members").Get<string[]>() ?? [],
                emailEnabled = _config.GetValue("Email:Enabled", false)
            }
        });
    }
}
