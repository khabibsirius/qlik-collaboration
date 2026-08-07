using System.Reflection;
using Dapper;
using Npgsql;

namespace QlikCollaboration.Api.Services;

/// <summary>
/// Makes the app and the database disagree loudly and usefully, instead of quietly.
///
/// database/schema.sql is applied by hand (Option A/B) or by the Postgres container's
/// init directory, which only runs on an EMPTY volume (Option C). Neither re-runs when
/// the app is upgraded, so a release that adds a column starts against a database that
/// does not have it. What that looked like was a crash loop printing an Npgsql stack
/// trace every second — accurate about what failed, silent about what to do.
///
/// The schema is embedded in the assembly rather than read from disk: the running code
/// and the schema it expects then travel together, and cannot be a checkout apart.
/// </summary>
public static class SchemaGuard
{
    /// <summary>
    /// Columns and tables added after the first release. Each entry is something the
    /// code now depends on; a database missing any of them will fail at runtime.
    /// </summary>
    private static readonly (string Table, string? Column, string AddedIn)[] Required =
    [
        ("users",       "role",       "roles"),
        ("comments",    "app_name",   "dashboard titles in the inbox"),
        ("comments",    "sheet_name", "dashboard titles in the inbox"),
        ("digest_runs", null,         "the e-mail digest")
    ];

    /// <summary>
    /// Indexes the data depends on for its meaning, not merely for speed. This one
    /// keeps one row per person however their name is capitalised; without it two rows
    /// exist for the same person and the role lookup returns whichever it finds first.
    /// Checked separately because schema.sql cannot build it while such a pair exists,
    /// and warns and carries on rather than failing — easy to miss in a long log.
    /// </summary>
    private static readonly (string Name, string Purpose)[] RequiredIndexes =
    [
        ("idx_users_username_lower", "one user row per person regardless of capitalisation")
    ];

    /// <summary>Names differing only in case — what blocks that index.</summary>
    public static async Task<List<string>> DuplicateNamesAsync(NpgsqlConnection conn) =>
        (await conn.QueryAsync<string>(
            @"SELECT string_agg(username, ' and ' ORDER BY username)
              FROM users GROUP BY lower(username) HAVING count(*) > 1")).ToList();

    public static async Task<List<string>> MissingAsync(NpgsqlConnection conn)
    {
        var missing = new List<string>();
        foreach (var (table, column, feature) in Required)
        {
            bool present = column is null
                ? await conn.ExecuteScalarAsync<bool>(
                    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = @table)",
                    new { table })
                : await conn.ExecuteScalarAsync<bool>(
                    @"SELECT EXISTS (SELECT 1 FROM information_schema.columns
                                     WHERE table_name = @table AND column_name = @column)",
                    new { table, column });

            if (!present)
                missing.Add(column is null ? $"table {table} ({feature})"
                                           : $"{table}.{column} ({feature})");
        }

        return missing;
    }

    /// <summary>The schema.sql this build was compiled with.</summary>
    public static string EmbeddedSchema()
    {
        var asm = Assembly.GetExecutingAssembly();
        var name = asm.GetManifestResourceNames().FirstOrDefault(n => n.EndsWith("schema.sql", StringComparison.OrdinalIgnoreCase))
                   ?? throw new InvalidOperationException("schema.sql is not embedded in this build.");
        using var stream = asm.GetManifestResourceStream(name)!;
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    /// <summary>
    /// Applies the embedded schema. Every statement in it is idempotent — CREATE TABLE
    /// IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, guarded DO blocks — so running it
    /// against an up-to-date database changes nothing.
    /// </summary>
    public static async Task ApplyAsync(NpgsqlConnection conn) =>
        await conn.ExecuteAsync(EmbeddedSchema());

    /// <summary>
    /// Returns true when the database is usable. Logs what to do when it is not.
    /// </summary>
    public static async Task<bool> EnsureAsync(NpgsqlDataSource db, bool autoApply, ILogger log)
    {
        await using var conn = await db.OpenConnectionAsync();

        // Advisory, not fatal. Nothing in the code needs this index any more — user
        // registration updates-then-inserts rather than relying on ON CONFLICT — so a
        // database without it still serves comments correctly. What it costs is
        // certainty about roles for the duplicated person, which is worth saying every
        // time and not worth refusing to start over.
        foreach (var (name, purpose) in RequiredIndexes)
        {
            var hasIndex = await conn.ExecuteScalarAsync<bool>(
                "SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = @name)", new { name });
            if (hasIndex) continue;

            var dups = await DuplicateNamesAsync(conn);
            if (dups.Count > 0)
                log.LogWarning(
                    "users holds {Count} name(s) differing only in capitalisation: {Pairs}. " +
                    "The {Index} index cannot be built while they exist, so the schema skips " +
                    "it and that person's role is whichever row is found first. Merge each " +
                    "pair — keep the spelling Qlik reports — then re-run the schema.",
                    dups.Count, string.Join("; ", dups), name);
            else
                log.LogWarning("Index {Index} is missing ({Purpose}). Re-run the schema to add it.",
                               name, purpose);
        }

        var missing = await MissingAsync(conn);
        if (missing.Count == 0) return true;

        if (autoApply)
        {
            log.LogWarning("Database is behind this build ({Missing}) — applying the schema.",
                           string.Join("; ", missing));
            await ApplyAsync(conn);

            var still = await MissingAsync(conn);
            if (still.Count == 0)
            {
                log.LogInformation("Schema applied; database is up to date.");
                return true;
            }
            log.LogCritical("Applying the schema did not add: {Missing}", string.Join("; ", still));
            return false;
        }

        var nl = Environment.NewLine;
        log.LogCritical(
            "This build needs database changes that are not there yet: {Missing}." + nl +
            "Apply them once — the file is idempotent, so it is safe on a live database " +
            "and keeps every existing comment:" + nl +
            "    psql -U postgres -d qlik_collaboration -f database/schema.sql" + nl +
            "Or set Database:ApplySchemaOnStart=true (env: Database__ApplySchemaOnStart=true) " +
            "to let the API apply it itself at startup.",
            string.Join("; ", missing));
        return false;
    }
}
