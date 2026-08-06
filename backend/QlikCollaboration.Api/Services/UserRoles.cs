using Dapper;
using Npgsql;

namespace QlikCollaboration.Api.Services;

/// <summary>
/// Who may see and do what.
///
///   guest — sees only the threads they started. The default, and the safe one:
///           two executives must not read each other's feedback.
///   team  — sees every thread, and is the audience notifications go to.
///   admin — team, plus may delete anyone's comment and change other people's roles.
///
/// Roles live in the database rather than in configuration because they are managed
/// from the team inbox at runtime; <c>Team:Members</c> and <c>Team:Admins</c> only seed
/// them, so a fresh install has someone who can log in and promote the rest.
///
/// This is NOT a security boundary. Like the rest of this API it trusts the username
/// it is handed (see docs/Enterprise.md) — it decides what the interface offers, not
/// what a determined caller can reach. Enforcing it needs the authentication work
/// listed there.
/// </summary>
public class UserRoles
{
    public const string Admin = "admin";
    public const string Team = "team";
    public const string Guest = "guest";

    public static readonly string[] All = [Admin, Team, Guest];

    public static bool IsValid(string? role) => role is not null && All.Contains(role);

    /// <summary>Admins and team members see every thread; guests see only their own.</summary>
    public static bool SeesEverything(string? role) => role is Admin or Team;

    /// <summary>Only admins may delete other people's comments and set roles.</summary>
    public static bool CanModerate(string? role) => role == Admin;

    /// <summary>The role of a user, or 'guest' for a name that has never been seen.</summary>
    public static async Task<string> Of(NpgsqlConnection conn, string? username, NpgsqlTransaction? tx = null)
    {
        if (string.IsNullOrWhiteSpace(username)) return Guest;
        var role = await conn.ExecuteScalarAsync<string?>(
            "SELECT role FROM users WHERE lower(username) = lower(@username)",
            new { username = username.Trim() }, tx);
        return role ?? Guest;
    }

    /// <summary>
    /// Everyone who should be notified about any comment: the team and the admins.
    /// A guest hears only about their own threads, handled by the caller.
    /// </summary>
    public static async Task<List<string>> NotifyAudience(NpgsqlConnection conn, NpgsqlTransaction? tx = null)
    {
        var rows = await conn.QueryAsync<string>(
            "SELECT username FROM users WHERE role IN ('admin', 'team')",
            transaction: tx);
        return rows.ToList();
    }
}
