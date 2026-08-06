using Dapper;
using Microsoft.AspNetCore.Mvc;
using Npgsql;
using QlikCollaboration.Api.Services;

namespace QlikCollaboration.Api.Controllers;

[ApiController]
[Route("api/users")]
public class UsersController : ControllerBase
{
    private readonly NpgsqlDataSource _db;

    public UsersController(NpgsqlDataSource db) => _db = db;

    public class PersonDto
    {
        public string Username { get; set; } = "";
        public string Role { get; set; } = UserRoles.Guest;
        public string? UserDirectory { get; set; }
        public DateTime CreatedAt { get; set; }
        /// <summary>Threads started, so the roles screen shows who is actually active.</summary>
        public int Threads { get; set; }
        public int Replies { get; set; }
        public DateTime? LastSeen { get; set; }
    }

    /// <summary>
    /// Everyone the team knows about, with their role and how much they have written.
    /// Feeds the roles screen in the team inbox.
    /// </summary>
    [HttpGet]
    public async Task<IEnumerable<PersonDto>> Get()
    {
        await using var conn = await _db.OpenConnectionAsync();
        return await conn.QueryAsync<PersonDto>(
            @"SELECT u.username, u.role, u.user_directory, u.created_at,
                     COUNT(c.id) FILTER (WHERE c.parent_id IS NULL AND c.is_deleted = FALSE) AS threads,
                     COUNT(c.id) FILTER (WHERE c.parent_id IS NOT NULL AND c.is_deleted = FALSE) AS replies,
                     MAX(c.created_at) AS last_seen
              FROM users u
              LEFT JOIN comments c ON lower(c.author) = lower(u.username)
              GROUP BY u.id
              ORDER BY
                CASE u.role WHEN 'admin' THEN 0 WHEN 'team' THEN 1 ELSE 2 END,
                lower(u.username)");
    }

    public record RegisterUserDto(string Username, string? UserDirectory = null);

    /// <summary>
    /// Announce a user who has opened the panel. Comments notify every known user,
    /// so without this a colleague who only reads would never be in that audience —
    /// they would start receiving notifications only after posting their first comment.
    /// New arrivals are guests; a role is granted deliberately, never by showing up.
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
              ON CONFLICT (lower(username)) DO UPDATE
                SET user_directory = COALESCE(EXCLUDED.user_directory, users.user_directory)",
            new { username, directory = string.IsNullOrWhiteSpace(dto.UserDirectory) ? null : dto.UserDirectory.Trim() });
        return NoContent();
    }

    public record SetRoleDto(string Role, string By);

    /// <summary>
    /// Change someone's role. <c>By</c> is the admin doing it.
    ///
    /// Like everything else here this trusts the name it is given, so it is a
    /// permission model rather than a security boundary — see docs/Enterprise.md. It
    /// decides what the interface offers, not what a determined caller can reach.
    /// </summary>
    [HttpPut("{username}/role")]
    public async Task<IActionResult> SetRole(string username, SetRoleDto dto)
    {
        if (!UserRoles.IsValid(dto.Role))
            return BadRequest(new { error = $"Role must be one of: {string.Join(", ", UserRoles.All)}" });

        await using var conn = await _db.OpenConnectionAsync();

        if (!UserRoles.CanModerate(await UserRoles.Of(conn, dto.By)))
            return StatusCode(403, new { error = "Only an admin can change roles." });

        // Demoting the last admin would leave the roles screen read-only, with no way
        // back short of editing configuration and restarting the server.
        if (!UserRoles.CanModerate(dto.Role) &&
            UserRoles.CanModerate(await UserRoles.Of(conn, username)))
        {
            var admins = await conn.ExecuteScalarAsync<long>(
                "SELECT count(*) FROM users WHERE role = 'admin'");
            if (admins <= 1)
                return BadRequest(new { error = "This is the only admin — promote someone else first." });
        }

        var affected = await conn.ExecuteAsync(
            "UPDATE users SET role = @role WHERE lower(username) = lower(@username)",
            new { username = username.Trim(), role = dto.Role });

        return affected == 0 ? NotFound(new { error = $"No such user: {username}" }) : NoContent();
    }
}
