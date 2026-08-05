using Dapper;
using Npgsql;

var builder = WebApplication.CreateBuilder(args);

// Allows running as a Windows Service on the server (no-op when run normally):
//   sc.exe create QlikCollaboration binPath= "...\QlikCollaboration.Api.exe"
builder.Host.UseWindowsService();

// Map snake_case DB columns (app_id) to PascalCase C# properties (AppId)
DefaultTypeMap.MatchNamesWithUnderscores = true;

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();
builder.Services.AddSignalR();

// Single pooled data source for the whole app
builder.Services.AddSingleton(_ =>
    NpgsqlDataSource.Create(builder.Configuration.GetConnectionString("Postgres")!));

// The extension is served from the Qlik client origin (http://localhost:4848 on
// Desktop, the Qlik Proxy host on Enterprise). Dev policy: allow all origins.
// TODO(Enterprise): restrict to the Qlik Sense host + add JWT auth.
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();

app.UseSwagger();
app.UseSwaggerUI();
app.UseCors();
app.MapControllers();
app.MapHub<QlikCollaboration.Api.Hubs.CommentsHub>("/hubs/comments");

// Listen address comes from appsettings.json "Urls" (or ASPNETCORE_URLS).
// Dev default: http://localhost:5000. On a server: http://0.0.0.0:5000 or an
// https binding — see docs/Enterprise.md.
app.Run();
