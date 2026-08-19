using System.Reflection;
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
builder.Services.AddSingleton<RoleSeeder>();
builder.Services.AddScoped<DigestBuilder>();
// Singleton and hosted service are the same instance, so the controller's manual
// trigger runs the identical code path as the timer rather than a copy of it.
builder.Services.AddSingleton<EmailDigestService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<EmailDigestService>());

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
//
// CorsOrigins compares normalised origins rather than raw strings, because a
// trailing slash on this setting refuses every write from the panel and says so to
// nobody — see the note there.
var corsOrigins = new CorsOrigins(builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>());
builder.Services.AddSingleton(corsOrigins);
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
{
    if (corsOrigins.AllowAny) p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod();
    else p.SetIsOriginAllowed(corsOrigins.IsAllowed).AllowAnyHeader().AllowAnyMethod().AllowCredentials();
}));

var app = builder.Build();

corsOrigins.ReportAtStartup(app.Logger);

// The database has to have the columns this build uses before anything reads them.
// Upgrading the app does not upgrade the database: schema.sql is applied by hand, and
// the Postgres container's init directory only runs on an empty volume. Without this
// check a missing column surfaced as an Npgsql stack trace in a restart loop.
if (!await SchemaGuard.EnsureAsync(
        app.Services.GetRequiredService<NpgsqlDataSource>(),
        builder.Configuration.GetValue("Database:ApplySchemaOnStart", false),
        app.Logger))
{
    return 1;      // the message above says what to run; a stack trace would not
}

// Roles are managed from the team inbox and only seeded from configuration, so this
// runs once at startup to apply Team:Admins / Team:Members and to say plainly when
// nobody can administer anything yet.
await app.Services.GetRequiredService<RoleSeeder>().RunAsync();

// Swagger is handy on a pilot server but is an unnecessary surface in production —
// turn it off with Swagger:Enabled=false.
if (builder.Configuration.GetValue("Swagger:Enabled", true))
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

// An unhandled exception was reaching the client as a bare 500 with the reason only
// in the container log — so "it shows an error" was all anyone could report, and
// every diagnosis started by asking for the log. The reason now travels with the
// response, and the panel shows it.
app.UseExceptionHandler(branch => branch.Run(async context =>
{
    var error = context.Features
        .Get<Microsoft.AspNetCore.Diagnostics.IExceptionHandlerFeature>()?.Error;

    var log = context.RequestServices.GetRequiredService<ILogger<Program>>();
    log.LogError(error, "Unhandled error on {Method} {Path}", context.Request.Method, context.Request.Path);

    context.Response.StatusCode = StatusCodes.Status500InternalServerError;
    context.Response.ContentType = "application/json";

    // A Postgres error carries the useful part in its own message; anything else
    // falls back to the exception type and text.
    var reason = error switch
    {
        Npgsql.PostgresException pg => $"database: {pg.MessageText}" +
                                       (pg.Hint is null ? "" : $" ({pg.Hint})"),
        null => "unknown error",
        _ => error.Message
    };

    await context.Response.WriteAsJsonAsync(new
    {
        error = reason,
        traceId = context.TraceIdentifier
    });
}));

app.UseCors();

// Port 5000 is the API. The only thing served as a page is the admin panel, at
// /admin — so an integration pointing at the root gets an API, not a UI.
// /admin is the address people type; /admin/ is the one DefaultFiles can resolve to
// an index.html. Middleware rather than a mapped route, because routing treats the
// two as the same endpoint — a route here matched /admin/ as well and redirected it
// to itself, forever.
app.Use(async (context, next) =>
{
    if (context.Request.Path == "/admin")
    {
        context.Response.Redirect("/admin/");
        return;
    }
    await next();
});

app.UseDefaultFiles();     // /admin/ -> /admin/index.html
app.UseStaticFiles();

// A build that predates the inbox page — or a container built from a stale publish
// folder, which Dockerfile.prebuilt copies verbatim — answers /health perfectly while
// "/" returns 404. Those two symptoms together look like a routing problem and are
// not, so name the real cause once, at startup, where the log will be looked at.
var inboxPage = Path.Combine(app.Environment.WebRootPath ?? "", "admin", "index.html");
if (File.Exists(inboxPage))
    app.Logger.LogInformation("Admin panel served at /admin");
else
    app.Logger.LogWarning(
        "wwwroot/admin/index.html is missing from this build, so the admin panel at /admin " +
        "will 404 " +
        "while the API itself works. Re-run `dotnet publish` and rebuild the image — a " +
        "publish folder made before the inbox existed does not contain it.");

app.MapControllers();
app.MapHub<CommentsHub>("/hubs/comments");

// The root is the API's front door: what this is and where to go. Deliberately not
// a page — the admin panel is at /admin and nowhere else.
app.MapGet("/", () => Results.Ok(new
{
    service = "Qlik Collaboration API",
    version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(),
    admin = "/admin",
    health = "/health",
    diagnostics = "/api/diagnostics"
}));

// Which Qlik to send people back to. There is one of these per deployment — a
// Desktop machine, a test server and a production server all have different hosts —
// so the panel reads it at runtime instead of being rebuilt for each.
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

// Where this process is actually listening, and whether anyone else can reach it.
// With no ASPNETCORE_URLS the default is localhost only, which serves the server's
// own browser perfectly and is invisible to every user workstation — and the panel
// reports that as "no response", the same words it uses for a backend that is down.
app.Lifetime.ApplicationStarted.Register(() =>
{
    var addresses = app.Urls.ToArray();
    if (addresses.Length == 0) return;          // hosted differently (IIS, tests)

    app.Logger.LogInformation("Listening on {Addresses}", string.Join(", ", addresses));

    var loopbackOnly = addresses.All(a =>
        Uri.TryCreate(a, UriKind.Absolute, out var u) &&
        (u.IsLoopback || u.Host is "localhost"));

    // Correct for Qlik Sense Desktop, where the browser is on this machine too — so
    // this says what it means rather than asserting something is broken.
    if (loopbackOnly && !app.Environment.IsDevelopment())
        app.Logger.LogWarning(
            "This API is bound to {Addresses} — loopback only, so it can be reached from " +
            "this machine and from nowhere else. That is right for Qlik Sense Desktop on " +
            "this same machine. It is wrong for a server: the extension runs in each " +
            "user's own browser, so every panel would report that the backend did not " +
            "answer. For a server set ASPNETCORE_URLS=http://0.0.0.0:5000 and open the " +
            "port in the firewall.",
            string.Join(", ", addresses));
});

app.Run();
return 0;
