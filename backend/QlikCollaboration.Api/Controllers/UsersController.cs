using Dapper;
using Microsoft.AspNetCore.Mvc;
using Npgsql;

namespace QlikCollaboration.Api.Controllers;

[ApiController]
[Route("api/users")]
public class UsersController : ControllerBase
{
    private readonly NpgsqlDataSource _db;

    public UsersController(NpgsqlDataSource db) => _db = db;

    /// <summary>Everyone the team knows about — the audience every comment is broadcast to.</summary>
    [HttpGet]
    public async Task<IEnumerable<string>> Get()
    {
        await using var conn = await _db.OpenConnectionAsync();
        return await conn.QueryAsync<string>("SELECT username FROM users ORDER BY username");
    }

    public record RegisterUserDto(string Username, string? UserDirectory = null);

    /// <summary>
    /// Announce a user who has opened the panel. Comments notify every known user,
    /// so without this a colleague who only reads would never be in that audience —
    /// they would start receiving notifications only after posting their first comment.
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> Register(RegisterUserDto dto)
    {
        if (string.IsNullOrWhiteSpace(dto.Username)) return BadRequest("Username is required.");
        var username = dto.Username.Trim();

        await using var conn = await _db.OpenConnectionAsync();
        await conn.ExecuteAsync(
            @"INSERT INTO users (username, display_name, user_directory)
              VALUES (@username, @username, @directory)
              ON CONFLICT (username) DO UPDATE
                SET user_directory = COALESCE(EXCLUDED.user_directory, users.user_directory)",
            new { username, directory = string.IsNullOrWhiteSpace(dto.UserDirectory) ? null : dto.UserDirectory.Trim() });
        return NoContent();
    }
}
