using Dapper;
using Npgsql;
using QlikCollaboration.Api.Hubs;
using QlikCollaboration.Api.Services;

var builder = WebApplication.CreateBuilder(args);

// Lets the published exe run as a Windows Service (no-op elsewhere, e.g. in a
// Linux container):  sc.exe create QlikCollaboration binPath= "...\QlikCollaboration.Api.exe"
builder.Host.UseWindowsService();

// Map snake_case DB columns (app_id) to PascalCase C# properties (AppId)
DefaultTypeMap.MatchNamesWithUnderscores = true;

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();
builder.Services.AddSignalR();
builder.Services.AddSingleton<TeamRoster>();

var connectionString = builder.Configuration.GetConnectionString("Postgres");
if (string.IsNullOrWhiteSpace(connectionString))
    throw new InvalidOperationException(
        "No PostgreSQL connection string. Set ConnectionStrings:Postgres in appsettings.json " +
        "or the ConnectionStrings__Postgres environment variable.");

// Single pooled data source for the whole app
builder.Services.AddSingleton(_ => NpgsqlDataSource.Create(connectionString));

// Browsers call this API from the Qlik client origin: http://localhost:4848 on
// Desktop, the Qlik Proxy host on Enterprise. Leave Cors:AllowedOrigins empty (or
// "*") for development; list the Qlik hosts in production.
var allowedOrigins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>() ?? [];
var allowAnyOrigin = allowedOrigins.Length == 0 || allowedOrigins.Contains("*");
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
{
    if (allowAnyOrigin) p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod();
    else p.WithOrigins(allowedOrigins).AllowAnyHeader().AllowAnyMethod().AllowCredentials();
}));

var app = builder.Build();

app.Logger.LogInformation("CORS: {Policy}",
    allowAnyOrigin ? "any origin (development)" : string.Join(", ", allowedOrigins));

// Worth saying out loud at startup: an empty roster means every user is treated as a
// guest and sees only their own threads, which looks exactly like "the panel lost all
// the comments" to the team that configured nothing.
var roster = app.Services.GetRequiredService<TeamRoster>();
if (roster.Count == 0)
    app.Logger.LogWarning(
        "Team:Members is empty — every user is treated as a guest and will see only " +
        "the threads they started. List the BI team's usernames to give them the full view.");
else
    app.Logger.LogInformation("BI team ({Count}): {Members}",
        roster.Count, string.Join(", ", roster.Members));

// Swagger is handy on a pilot server but is an unnecessary surface in production —
// turn it off with Swagger:Enabled=false.
if (builder.Configuration.GetValue("Swagger:Enabled", true))
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseCors();

// The team inbox is a static page served by this same app: no extra host, no extra
// port, no CORS, and it ships wherever the API ships.
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapControllers();
app.MapHub<CommentsHub>("/hubs/comments");

// Which Qlik to send people back to. There is one of these per deployment — a
// Desktop machine, a test server and a production server all have different hosts —
// so the inbox reads it at runtime instead of being rebuilt for each.
app.MapGet("/api/config", (IConfiguration config) => Results.Ok(new
{
    qlikBaseUrl = (config["Qlik:BaseUrl"] ?? "http://localhost:4848").TrimEnd('/')
}));

// Liveness + database probe, used by the container healthcheck and by monitoring.
app.MapGet("/health", async (NpgsqlDataSource db, ILogger<Program> log) =>
{
    try
    {
        await using var conn = await db.OpenConnectionAsync();
        await conn.ExecuteScalarAsync<int>("SELECT 1");
        return Results.Ok(new { status = "healthy", database = "up" });
    }
    catch (Exception ex)
    {
        log.LogError(ex, "Health check failed: database unreachable");
        return Results.Json(new { status = "unhealthy", database = "down" }, statusCode: 503);
    }
});

app.Run();
