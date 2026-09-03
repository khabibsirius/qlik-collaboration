using System.Text.RegularExpressions;
using Dapper;
using Npgsql;

namespace QlikCollaboration.Api.Services;

/// <summary>
/// Whether a discussion is public, and who may be @mentioned in it.
///
/// Private is the default and the original behaviour: the BI team sees every thread,
/// everyone else sees only the threads they started, so two executives never read
/// each other's feedback. Public opts one app — or one sheet — out of that, and
/// everyone who can open the sheet sees the whole discussion.
///
/// The setting lives here rather than in the extension's property panel because it is
/// a privacy control. A value stored in the Qlik app would be sent by the client, and
/// a client that can assert "this sheet is public" is not a control at all. Like the
/// rest of this API it still trusts the username it is handed (see docs/Enterprise.md)
/// — what it stops is the interface disclosing threads, not a determined caller.
/// </summary>
public static class Visibility
{
    /// <summary>The app-wide row. A primary key column cannot be NULL, so '' carries that meaning.</summary>
    public const string AppWide = "";

    public record Setting(string AppId, string SheetId, bool IsPublic, string SetBy, DateTime SetAt);

    /// <summary>
    /// The effective public flag of the comment aliased <c>c</c>, as SQL, for queries
    /// whose rows each belong to a different sheet — notifications, and anything else
    /// that spans apps. Same precedence as <see cref="ResolveAsync"/>: the sheet's own
    /// row wins, then the app-wide row, then private. Change one and change the other.
    /// </summary>
    public const string IsPublicSql =
        @"COALESCE((SELECT v.is_public FROM comment_visibility v
                     WHERE v.app_id = c.app_id AND v.sheet_id IN (c.sheet_id, '')
                     ORDER BY (v.sheet_id = '')
                     LIMIT 1), FALSE)";

    /// <summary>Where an effective value came from, for the admin screen and the panel.</summary>
    public record Resolved(bool IsPublic, string Source)
    {
        public static readonly Resolved Private = new(false, "default");
    }

    /// <summary>
    /// The effective setting for one sheet: its own row wins, then the app-wide row,
    /// then private. One query rather than two round trips — ordering on
    /// (sheet_id = '') puts the exact sheet first, because false sorts before true.
    ///
    /// <see cref="IsPublicSql"/> is the same rule expressed for row-wise queries.
    /// </summary>
    public static async Task<Resolved> ResolveAsync(
        NpgsqlConnection conn, string appId, string sheetId, NpgsqlTransaction? tx = null)
    {
        var row = await conn.QuerySingleOrDefaultAsync<(bool IsPublic, string SheetId)?>(
            @"SELECT is_public, sheet_id FROM comment_visibility
              WHERE app_id = @appId AND sheet_id IN (@sheetId, '')
              ORDER BY (sheet_id = '')
              LIMIT 1",
            new { appId, sheetId = sheetId ?? "" }, tx);

        if (row is null) return Resolved.Private;
        return new Resolved(row.Value.IsPublic, row.Value.SheetId == AppWide ? "app" : "sheet");
    }

    /// <summary>Convenience for the many callers that only need the answer.</summary>
    public static async Task<bool> IsPublicAsync(
        NpgsqlConnection conn, string appId, string sheetId, NpgsqlTransaction? tx = null) =>
        (await ResolveAsync(conn, appId, sheetId, tx)).IsPublic;

    /// <summary>Create or replace one row. <paramref name="sheetId"/> empty = app-wide.</summary>
    public static async Task SetAsync(
        NpgsqlConnection conn, string appId, string? sheetId, bool isPublic, string setBy) =>
        await conn.ExecuteAsync(
            @"INSERT INTO comment_visibility (app_id, sheet_id, is_public, set_by, set_at)
              VALUES (@appId, @sheetId, @isPublic, @setBy, now())
              ON CONFLICT (app_id, sheet_id)
              DO UPDATE SET is_public = EXCLUDED.is_public,
                            set_by    = EXCLUDED.set_by,
                            set_at    = EXCLUDED.set_at",
            new { appId, sheetId = sheetId ?? AppWide, isPublic, setBy });

    /// <summary>
    /// Remove a row so the level above decides again — clearing a sheet override
    /// returns it to the app's setting, clearing the app row returns it to private.
    /// </summary>
    public static async Task<bool> ClearAsync(NpgsqlConnection conn, string appId, string? sheetId) =>
        await conn.ExecuteAsync(
            "DELETE FROM comment_visibility WHERE app_id = @appId AND sheet_id = @sheetId",
            new { appId, sheetId = sheetId ?? AppWide }) > 0;

    // @ then the characters an account name is actually made of. Deliberately does not
    // match a trailing dot or an e-mail address's domain, and stops at whitespace, so
    // "write to ivanov@bank.local" does not silently mention anyone.
    private static readonly Regex MentionPattern =
        new(@"(?<![\w@.])@([A-Za-z0-9._\-]{1,64}?)(?=[^\w.\-]|$)", RegexOptions.Compiled);

    /// <summary>
    /// The names actually mentioned in a comment: every @token that matches a real
    /// user, resolved to the spelling the users table holds so the notification and
    /// the mentions row agree with it.
    ///
    /// Matching against the table rather than trusting the text is what keeps a typo
    /// from creating a notification nobody ever receives, and keeps "@everyone" from
    /// looking like a feature it is not.
    /// </summary>
    public static async Task<List<string>> ResolveMentionsAsync(
        NpgsqlConnection conn, string body, NpgsqlTransaction? tx = null)
    {
        var tokens = MentionPattern.Matches(body ?? "")
            .Select(m => m.Groups[1].Value.TrimEnd('.', '-', '_'))
            .Where(t => t.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        if (tokens.Length == 0) return [];

        var known = await conn.QueryAsync<string>(
            @"SELECT username FROM users
              WHERE lower(username) = ANY(SELECT lower(unnest(@tokens::text[])))",
            new { tokens }, tx);

        return known.ToList();
    }
}
