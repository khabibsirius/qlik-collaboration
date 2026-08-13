using Dapper;
using Npgsql;

namespace QlikCollaboration.Api.Services;

/// <summary>What a digest e-mail is about to say. Built by <see cref="DigestBuilder"/>.</summary>
public class DigestReport
{
    /// <summary>Comments written since the last digest went out.</summary>
    public List<DigestItem> New { get; set; } = [];

    /// <summary>Open threads nobody has replied to yet, however old.</summary>
    public List<DigestItem> Waiting { get; set; } = [];

    /// <summary>When the previous digest was sent; null if this is the first ever.</summary>
    public DateTime? Since { get; set; }

    /// <summary>
    /// Nothing new and nothing waiting means there is nothing worth an e-mail. Sending
    /// one anyway is how a digest teaches people to ignore it.
    /// </summary>
    public bool IsEmpty => New.Count == 0 && Waiting.Count == 0;
}

public class DigestItem
{
    public int Id { get; set; }
    public string AppId { get; set; } = "";
    public string SheetId { get; set; } = "";
    public string? AppName { get; set; }
    public string? SheetName { get; set; }
    public string Author { get; set; } = "";
    public string Body { get; set; } = "";
    public string Status { get; set; } = "new";
    public DateTime CreatedAt { get; set; }
    public bool IsReply { get; set; }
    public int ReplyCount { get; set; }

    public string Dashboard => string.IsNullOrWhiteSpace(AppName) ? AppId : AppName;
    public string Sheet => string.IsNullOrWhiteSpace(SheetName) ? SheetId : SheetName;
}

public class DigestBuilder
{
    private readonly NpgsqlDataSource _db;

    public DigestBuilder(NpgsqlDataSource db) => _db = db;

    public async Task<DateTime?> LastSentAsync(NpgsqlConnection conn) =>
        await conn.ExecuteScalarAsync<DateTime?>("SELECT max(sent_at) FROM digest_runs");

    public async Task<DigestReport> BuildAsync()
    {
        await using var conn = await _db.OpenConnectionAsync();
        var since = await LastSentAsync(conn);

        // First run has no previous digest to measure from. Reporting every comment
        // ever written as "new" would make the first e-mail useless, so treat the
        // last day as new and let the waiting list carry the older backlog.
        var from = since ?? DateTime.UtcNow.AddDays(-1);

        var fresh = (await conn.QueryAsync<DigestItem>(
            @"SELECT c.id, c.app_id, c.sheet_id, c.app_name, c.sheet_name,
                     c.author, c.body, c.status, c.created_at,
                     (c.parent_id IS NOT NULL) AS is_reply,
                     0 AS reply_count
              FROM comments c
              WHERE c.is_deleted = FALSE AND c.created_at > @from
              ORDER BY c.created_at", new { from })).ToList();

        var waiting = (await conn.QueryAsync<DigestItem>(
            @"SELECT c.id, c.app_id, c.sheet_id, c.app_name, c.sheet_name,
                     c.author, c.body, c.status, c.created_at,
                     FALSE AS is_reply,
                     0 AS reply_count
              FROM comments c
              WHERE c.parent_id IS NULL
                AND c.is_deleted = FALSE
                AND c.status <> 'closed'
                AND NOT EXISTS (SELECT 1 FROM comments r
                                WHERE r.parent_id = c.id AND r.is_deleted = FALSE)
              ORDER BY c.created_at", new { })).ToList();

        return new DigestReport { New = fresh, Waiting = waiting, Since = since };
    }

    public async Task RecordSentAsync(DigestReport report, string recipients)
    {
        await using var conn = await _db.OpenConnectionAsync();
        await conn.ExecuteAsync(
            @"INSERT INTO digest_runs (new_items, waiting, recipients)
              VALUES (@newItems, @waiting, @recipients)",
            new { newItems = report.New.Count, waiting = report.Waiting.Count, recipients });
    }
}
