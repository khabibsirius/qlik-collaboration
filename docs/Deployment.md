# Deployment

Two supported ways to run the backend. Pick one:

| | Docker Compose | Windows Service |
|---|---|---|
| Host | Linux VM (recommended) or a Windows machine with Docker Desktop | Windows Server, no Docker |
| Brings its own PostgreSQL | yes | no — point it at an existing instance |
| Bank change-control friendliness | needs a container runtime approved | usually easier: just a service + an exe |
| Command | `docker compose up -d` | `deploy\install-windows-service.ps1` |

> **Windows Server + Docker — read this first.**
> Our containers are *Linux* containers. Windows Server runs *Windows* containers
> natively; Linux containers there need Docker Desktop (which targets Windows 10/11)
> or a Linux VM. PostgreSQL has no official Windows-container image either. So on a
> Windows Server the realistic choices are: run the Compose stack on a **Linux VM**,
> or use the **Windows Service** path below.
>
> **Verification status:** Option B (Windows Service) is the tested path — the
> published service binary was run with a service-style environment block and
> confirmed working. The Compose files in Option A are written and reviewed but
> have not been executed end-to-end; treat them as a starting point if a Linux
> host ever becomes available.

---

## Option A — Docker Compose

### 1. Configure

```bash
cp .env.example .env
# edit .env: set a real POSTGRES_PASSWORD, and QLIK_ORIGIN to your Qlik host
```

`.env` is git-ignored. The stack refuses to start without `POSTGRES_PASSWORD`.

### 2. Start

```bash
docker compose up -d --build
docker compose ps          # both services should be "healthy"
curl http://localhost:5000/health
# {"status":"healthy","database":"up"}
```

`database/schema.sql` is mounted into the Postgres init directory, so the tables are
created automatically the first time the data volume is empty.

### 3. Everyday commands

```bash
docker compose logs -f api      # follow the API log
docker compose restart api      # after changing .env
docker compose down             # stop; comments and attachments are KEPT
docker compose down -v          # stop and DESTROY the data volumes
docker compose up -d --build    # deploy a new version of the code
```

### 4. Backups

Two volumes hold everything: `pgdata` (comments) and `uploads` (attachments).

```bash
# database dump
docker compose exec db pg_dump -U qlik qlik_collaboration > backup-$(date +%F).sql

# attachments
docker run --rm -v qlikchatext_uploads:/data -v "$PWD":/out alpine \
    tar czf /out/uploads-$(date +%F).tar.gz -C /data .
```

Restore the dump with `psql -U qlik -d qlik_collaboration < backup.sql`.

---

## Option B — Windows Service (no Docker)

**This is the path for a Windows-only environment.**

Prerequisites on the app server:

1. **.NET 8 Hosting Bundle** (or just the ASP.NET Core Runtime) —
   <https://dotnet.microsoft.com/download/dotnet/8.0>. The build machine needs the
   SDK; the server needs only the runtime.
2. **PostgreSQL reachable** — the bank's existing instance, or installed on this
   server — with the database and schema created:

```powershell
psql -U postgres -c "CREATE DATABASE qlik_collaboration;"
psql -U postgres -d qlik_collaboration -f database\schema.sql
```

3. The install script must be run from an **elevated** PowerShell (it creates a
   service and a firewall rule).

```powershell
# once, on the database server
psql -U postgres -c "CREATE DATABASE qlik_collaboration;"
psql -U postgres -d qlik_collaboration -f database\schema.sql
```

Then from an **elevated** PowerShell on the app server:

```powershell
.\deploy\install-windows-service.ps1 `
    -DbHost pg.bank.local `
    -DbUser qlik `
    -DbPassword '<password>' `
    -QlikOrigin https://qlik.bank.local `
    -ListenUrl 'http://+:5000'
```

The script publishes the app, installs the service (auto-start, auto-restart on
crash), stores the connection string in the service's own environment block in the
registry rather than a world-readable file, opens the firewall port, starts it and
verifies `/health`.

```powershell
Get-Service QlikCollaboration
.\deploy\install-windows-service.ps1 -Uninstall      # remove it again
```

Redeploying a new version = run the same install command again; it stops the
service, replaces the files and restarts.

---

## The Qlik extension (both options)

```powershell
.\deploy\package-extension.ps1     # -> dist\qlik-collaboration.zip
```

QMC → **Extensions** → **Import** → pick the zip. Qlik distributes it to every node;
never copy extension files to nodes by hand — a node re-sync overwrites them.

Then in each app: edit the sheet → drop the panel on it → set **Backend API URL** to
the server (e.g. `https://bi-collab.bank.local:5443`) and **User identity** to
*"Qlik identity only"*.

---

## Configuration reference

Every setting can come from `appsettings.json` **or** an environment variable
(`__` separates nested keys). Environment variables win, which is how both
deployment options inject secrets.

| Setting | Environment variable | Purpose |
|---|---|---|
| `ConnectionStrings:Postgres` | `ConnectionStrings__Postgres` | database connection |
| `Urls` | `ASPNETCORE_URLS` | listen address, e.g. `http://+:5000` |
| `Storage:AttachmentsPath` | `Storage__AttachmentsPath` | where uploaded files are written |
| `Cors:AllowedOrigins:0` | `Cors__AllowedOrigins__0` | allowed browser origin; `*` = any (dev only) |
| `Notifications:BroadcastWhenNoMention` | `Notifications__BroadcastWhenNoMention` | notify the whole team when a comment has no @mention |
| `Swagger:Enabled` | `Swagger__Enabled` | expose `/swagger` |

---

## Going to HTTPS

If Qlik Sense is served over HTTPS — it normally is — the browser will **block** calls
from the extension to an `http://` backend as mixed content. The backend must be
HTTPS too. Either:

- **Terminate TLS in front** (IIS, nginx, or the bank's reverse proxy) and forward to
  the container/service over HTTP. Make sure the proxy forwards WebSocket upgrade
  headers, or SignalR silently falls back to polling.
- **Or bind a certificate directly**: set `ASPNETCORE_URLS=https://+:5443` plus
  `ASPNETCORE_Kestrel__Certificates__Default__Path` and `__Password`.

Then set the extension's Backend API URL to `https://…`.

---

## Sizing

Measured, not estimated:

| Item | Size |
|---|---|
| Published app payload | 7.7 MB |
| API image (Debian-based .NET 8 runtime + app + curl) | ~230 MB |
| `postgres:16-alpine` | ~250 MB |
| Comment row incl. indexes | ~400 B |
| Notification row incl. indexes | ~150 B |

With a 20-person team, one comment plus its broadcast notifications is ~3.5 KB. At
50 comments a day that is **~45 MB of database growth per year** — negligible.
**Attachments dominate**: a voice message is ~0.5 MB per minute, and files are capped
at 25 MB. Budget from expected attachment volume, not from the comment count.

Recommended pilot VM: **2 vCPU, 4 GB RAM, 20–40 GB disk**.
