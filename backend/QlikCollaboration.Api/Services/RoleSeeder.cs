using Dapper;
using Npgsql;

namespace QlikCollaboration.Api.Services;

/// <summary>
/// Applies the configured roles to the database at startup.
///
/// Roles are managed from the team inbox, so configuration only has to answer the
/// chicken-and-egg question: on a fresh install nobody is an admin, so nobody can
/// promote anyone. <c>Team:Admins</c> names the first one.
///
///   "Team": { "Admins": [ "karimov" ], "Members": [ "ivanov", "petrov" ] }
///
/// Seeding only ever raises a role, never lowers one — otherwise every restart would
/// undo changes made in the panel, which is the sort of thing that looks like the
/// panel silently not saving.
/// </summary>
public class RoleSeeder
{
    private readonly NpgsqlDataSource _db;
    private readonly IConfiguration _config;
    private readonly ILogger<RoleSeeder> _log;

    public RoleSeeder(NpgsqlDataSource db, IConfiguration config, ILogger<RoleSeeder> log)
    {
        _db = db;
        _config = config;
        _log = log;
    }

    private string[] Configured(string key) =>
        (_config.GetSection(key).Get<string[]>() ?? [])
            .Where(n => !string.IsNullOrWhiteSpace(n))
            .Select(n => n.Trim())
            .ToArray();

    public async Task RunAsync()
    {
        var admins = Configured("Team:Admins");
        var members = Configured("Team:Members");

        await using var conn = await _db.OpenConnectionAsync();

        // A configured name may never have opened the panel yet, so create the row
        // rather than assuming it is there to be updated.
        foreach (var (names, role) in new[] { (members, UserRoles.Team), (admins, UserRoles.Admin) })
        {
            foreach (var name in names)
            {
                await conn.ExecuteAsync(
                    @"INSERT INTO users (username, display_name, role)
                      VALUES (@name, @name, @role)
                      ON CONFLICT (username) DO UPDATE SET role = @role
                      WHERE users.role <> 'admin' AND users.role <> @role",
                    new { name, role });
            }
        }

        var counts = (await conn.QueryAsync<(string Role, long Count)>(
            "SELECT role, count(*) FROM users GROUP BY role")).ToList();
        var adminCount = counts.FirstOrDefault(c => c.Role == UserRoles.Admin).Count;

        _log.LogInformation("Roles: {Summary}",
            counts.Count == 0 ? "no users yet"
                              : string.Join(", ", counts.Select(c => $"{c.Count} {c.Role}")));

        // Without an admin the roles screen is read-only and nobody can grant anything,
        // which from the panel looks like the buttons are broken.
        if (adminCount == 0)
            _log.LogWarning(
                "No user has the admin role, so nobody can change roles from the team inbox. " +
                "Add one to Team:Admins (env: Team__Admins__0=<username>) and restart.");
    }
}
