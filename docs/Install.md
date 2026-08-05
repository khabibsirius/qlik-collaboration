# Installation (development, Qlik Sense Desktop)

## Prerequisites

| Component | Version | Check |
|---|---|---|
| .NET SDK | 8.x | `dotnet --version` |
| PostgreSQL | 16 | service `postgresql-x64-16` running |
| Qlik Sense Desktop | current | free download from qlik.com (needs Qlik account) |

## 1. Database

```powershell
$env:PGPASSWORD='postgres'
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -h localhost -c "CREATE DATABASE qlik_collaboration;"
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -h localhost -d qlik_collaboration -f database\schema.sql
```

Connection string lives in `backend/QlikCollaboration.Api/appsettings.json`.

## 2. Backend

```powershell
dotnet run --project backend\QlikCollaboration.Api
```

Runs at `http://localhost:5000`. Verify: open `http://localhost:5000/swagger`.

## 3. Extension

Copy the extension folder into Qlik Sense Desktop's extension directory:

```powershell
Copy-Item -Recurse extension\qlik-collaboration "$env:USERPROFILE\Documents\Qlik\Sense\Extensions\"
```

> If a custom content folder was chosen during Qlik Desktop installation, use
> `<content folder>\Sense\Extensions` instead (on this dev machine: `C:\Qlik\doc\Sense\Extensions`).
> The `deploy-extension.ps1` script in the project root does this for you.

(Re-copy after every change; then hard-refresh the Qlik client with Ctrl+F5.)

## 4. Use it

1. Start Qlik Sense Desktop, open/create an app with a sheet.
2. Edit the sheet → **Custom objects** → **Qlik Collaboration** → drag onto the sheet
   (a narrow column on the right works well as the "panel").
3. Done editing → the panel shows comments for this sheet.
   - The dot in the header is green when the backend is reachable, red when not.
   - Extension settings (Backend API URL, refresh interval) are in the object's properties panel.

## Demo "real-time" on Desktop

Qlik Sense Desktop also serves the client to a browser: with Desktop running, open
`http://localhost:4848/hub` in Chrome — open the same sheet in **two windows**, write a
comment in one and watch it appear in the other within the refresh interval. No F5.

## Troubleshooting

- **Red dot / no comments** — backend not running or wrong API URL in extension settings.
- **Extension not in Custom objects list** — check the folder is directly under
  `Documents\Qlik\Sense\Extensions\qlik-collaboration\` (the .qext must be one level deep), then Ctrl+F5.
- **psql auth failed** — the dev superuser password was set to `postgres` at install.
