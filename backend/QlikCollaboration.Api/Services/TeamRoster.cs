namespace QlikCollaboration.Api.Services;

/// <summary>
/// Who is on the BI team. Everyone else — the executives the dashboards are built
/// for — is a guest, and a guest sees only the threads they started themselves.
/// Two executives must not read each other's feedback; the team reads all of it.
///
/// Membership is a configured list rather than a database flag or a screen: it is
/// five or six people that change once a year, it has to be reviewable by whoever
/// deploys, and there is no admin UI to protect. Usernames are the Qlik identity —
/// the AD account name on Enterprise.
///
///   "Team": { "Members": [ "karimov", "ivanov", "petrov" ] }
///   Team__Members__0=karimov  (environment variable form)
///
/// An empty list means everyone is treated as a guest, which is the safe direction
/// to fail: nobody sees anyone else's comments rather than everybody seeing
/// everybody's.
/// </summary>
public class TeamRoster
{
    private readonly HashSet<string> _members;

    public TeamRoster(IConfiguration config)
    {
        var configured = config.GetSection("Team:Members").Get<string[]>() ?? [];
        _members = new HashSet<string>(
            configured.Where(m => !string.IsNullOrWhiteSpace(m)).Select(m => m.Trim()),
            StringComparer.OrdinalIgnoreCase);
    }

    public int Count => _members.Count;

    public IReadOnlyCollection<string> Members => _members;

    /// <summary>True for a BI team member, who sees every thread on a sheet.</summary>
    public bool IsTeamMember(string? username) =>
        !string.IsNullOrWhiteSpace(username) && _members.Contains(username.Trim());
}
