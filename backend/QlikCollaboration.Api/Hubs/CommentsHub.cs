using Microsoft.AspNetCore.SignalR;

namespace QlikCollaboration.Api.Hubs;

/// <summary>
/// Real-time channel. The server broadcasts "commentsChanged" with {appId, sheetId}
/// whenever anything changes; clients on that sheet re-fetch. Notifications use
/// "notify" with the target username. No client->server methods needed (REST does writes).
/// </summary>
public class CommentsHub : Hub
{
}
