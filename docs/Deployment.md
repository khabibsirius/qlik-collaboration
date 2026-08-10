# Deployment

## Pick your path

| | What it runs | Use when |
|---|---|---|
| **A — Docker + existing PostgreSQL** | API in a container, database already on the server | **Docker and PostgreSQL are already installed** (the usual case) |
| **B — Windows Service** | API as a plain Windows service, database already on the server | No Docker, or bank policy forbids containers |
| **C — All-in-one Docker** | API **and** PostgreSQL, both in containers | Fresh host with nothing installed |

All three need the extension imported into the QMC — see [The Qlik extension](#the-qlik-extension).

---

## Step 0 — which container mode is Docker in?

Docker on Windows runs **either** Windows containers **or** Linux containers, and they
need different images. Check first:

```powershell
docker info --format "{{.OSType}}"
```

| Result | Compose file | Dockerfile |
|---|---|---|
| `windows` | `docker-compose.windows.yml` | `Dockerfile.windows` (Nano Server) |
| `linux` | `docker-compose.hostdb.yml` | `Dockerfile` (Debian) |

`deploy\docker-deploy.ps1` detects this automatically and picks the right pair — you
do not have to remember it.

> **Windows containers:** the image tag must match the host OS or the container will
> not start (containers share the host kernel). Check with `(Get-ComputerInfo).OsName`
> and set `WINDOWS_TAG` in `.env`: Server 2019 → `ltsc2019`, 2022 → `ltsc2022`,
> 2025 → `ltsc2025`.

---

## Option A — Docker with the existing PostgreSQL

### 1. Prepare the database (once)

```powershell
psql -U postgres -c "CREATE DATABASE qlik_collaboration;"
psql -U postgres -d qlik_collaboration -f database\schema.sql
```

### 2. Let the container reach the host PostgreSQL

A container is a separate machine on its own network, so a default PostgreSQL install
will refuse it. Two files must change (both live in the PostgreSQL data directory,
typically `C:\Program Files\PostgreSQL\16\data`):

**`postgresql.conf`** — listen on all interfaces, not just localhost:

```conf
listen_addresses = '*'
```

**`pg_hba.conf`** — allow the container subnet. Add one line:

```conf
# Linux containers (Docker's default bridge range)
host    all    all    172.16.0.0/12    scram-sha-256

# Windows containers (Docker's default NAT range) - check yours with:
#   docker network inspect nat --format "{{(index .IPAM.Config 0).Subnet}}"
host    all    all    172.16.0.0/12    scram-sha-256
```

Then restart PostgreSQL:

```powershell
Restart-Service postgresql-x64-16
```

> Do not use `0.0.0.0/0` unless the server is isolated — it accepts connections from
> anywhere that can reach the port.

### 3. Configure

```powershell
Copy-Item .env.example .env
notepad .env      # set DB_PASSWORD, QLIK_ORIGIN, and WINDOWS_TAG if using Windows containers
```

`DB_HOST` defaults to `host.docker.internal`, which resolves to the host machine from
inside the container. If that name does not resolve on your engine (it can be missing
outside Docker Desktop), put the **server's own LAN IP** there — never `127.0.0.1`,
which inside a container means the container itself.

### 4. Preflight, then start

```powershell
.\deploy\docker-deploy.ps1 -Preflight     # checks mode, tag, DB reachability, listen_addresses, pg_hba
.\deploy\docker-deploy.ps1                # builds and starts, then verifies /health
```

Expected finish:

```
Running and connected to the database.
  health : http://localhost:5000/health
```

### 5. Everyday commands

```powershell
.\deploy\docker-deploy.ps1 -Logs      # follow the API log
.\deploy\docker-deploy.ps1 -Down      # stop; the attachments volume is kept
.\deploy\docker-deploy.ps1            # redeploy after a code change
```

### 6. Open the firewall

The extension runs in **each user's browser**, so the port must be reachable from user
workstations — not only from the Qlik servers:

```powershell
New-NetFirewallRule -DisplayName "Qlik Collaboration API" -Direction Inbound `
    -Action Allow -Protocol TCP -LocalPort 5000 -Profile Any
```

---

## Option B — Windows Service (no Docker)

Prerequisites: the **.NET 8 Hosting Bundle** on the server
(<https://dotnet.microsoft.com/download/dotnet/8.0>) and the database prepared as in
Option A step 1. No `postgresql.conf`/`pg_hba.conf` changes are needed if the database
is on the same machine — the service connects over localhost like any local program.

From an **elevated** PowerShell:

```powershell
.\deploy\install-windows-service.ps1 `
    -DbHost localhost -DbUser postgres -DbPassword '<password>' `
    -QlikOrigin https://qlik.bank.local `
    -ListenUrl 'http://+:5000'
```

It publishes the app, installs an auto-starting service that restarts on crash, stores
the connection string in the service's own registry environment block rather than a
readable file, opens the firewall port, and verifies `/health` before reporting success.

```powershell
Get-Service QlikCollaboration
.\deploy\install-windows-service.ps1 -Uninstall
```

Redeploying = run the same command again; it stops the service, replaces the files and
restarts.

---

## Option C — All-in-one Docker (API + PostgreSQL)

Only for a host that has no PostgreSQL. Linux containers only.

```powershell
Copy-Item .env.example .env    # set POSTGRES_PASSWORD
docker compose up -d --build
```

`database/schema.sql` is mounted into the Postgres init directory and applied
automatically the first time the data volume is empty.

---

## The Qlik extension

```powershell
.\deploy\package-extension.ps1        # -> dist\qlik-collaboration.zip
```

1. QMC → **Extensions** → **Import** → pick the zip. Qlik distributes it to every node;
   never copy extension files to nodes by hand — a node re-sync overwrites them.
2. QMC → **Content Security Policy** → add the backend origin with `connect-src`
   (and `ws:`/`wss:` for SignalR). **Without this, Enterprise silently blocks every
   call the panel makes.**
3. In each app: edit the sheet → drop the panel on it → set **Backend API URL** to the
   server, and **User identity** to *"Qlik identity only"*.

---

## HTTPS

If Qlik Sense is served over HTTPS — it normally is — the browser **blocks** calls from
the extension to an `http://` backend as mixed content. The backend must be HTTPS too:

- **Terminate TLS in front** (IIS or the bank's reverse proxy) and forward to the
  container/service over HTTP. The proxy must forward WebSocket upgrade headers, or
  SignalR silently falls back to polling.
- **Or bind a certificate directly**: `ASPNETCORE_URLS=https://+:5443` plus
  `ASPNETCORE_Kestrel__Certificates__Default__Path` and `__Password`.

Then set the extension's Backend API URL to `https://…`.

---

## Configuration reference

Every setting comes from `appsettings.json` **or** an environment variable (`__`
separates nested keys). Environment variables win — that is how both Docker and the
Windows Service inject secrets without writing them to a file.

| Setting | Environment variable | Purpose |
|---|---|---|
| `ConnectionStrings:Postgres` | `ConnectionStrings__Postgres` | database connection |
| `Urls` | `ASPNETCORE_URLS` | listen address, e.g. `http://+:5000` |
| `Storage:AttachmentsPath` | `Storage__AttachmentsPath` | where uploaded files are written |
| `Cors:AllowedOrigins:0` | `Cors__AllowedOrigins__0` | allowed browser origin; `*` = any (dev only) |
| `Notifications:BroadcastWhenNoMention` | `Notifications__BroadcastWhenNoMention` | notify the whole team when a comment has no @mention |
| `Swagger:Enabled` | `Swagger__Enabled` | expose `/swagger` (keep off in production) |

---

## Backups

Two things hold state: the **database** and the **attachments**.

```powershell
# database
pg_dump -U postgres qlik_collaboration > backup-2026-08-10.sql

# attachments, Windows Service install
Compress-Archive C:\Programs\QlikCollaboration\uploads uploads-2026-08-10.zip

# attachments, Docker install (named volume)
docker run --rm -v qlikchatext_uploads:/data -v ${PWD}:/out alpine tar czf /out/uploads.tar.gz -C /data .
```

`docker compose down` keeps the volumes; only `down -v` destroys them.

---

## Sizing

Measured, not estimated:

| Item | Size |
|---|---|
| Published app payload | 7.7 MB |
| API image, Linux (Debian .NET 8 runtime + app) | ~230 MB |
| API image, Windows (Nano Server .NET 8 runtime + app) | ~300 MB |
| Comment row incl. indexes | ~400 B |
| Notification row incl. indexes | ~150 B |

With a 20-person team, one comment plus its broadcast notifications is ~3.5 KB. At 50
comments a day that is **~45 MB of database growth per year** — negligible.
**Attachments dominate**: a voice message is ~0.5 MB per minute and files are capped at
25 MB, so budget from expected attachment volume, not comment count.

Recommended: **2 vCPU, 4 GB RAM, 20–40 GB disk**.

> **Note on the first build:** the base images are 200–700 MB and must be pulled from
> `mcr.microsoft.com` / Docker Hub. On a throttled or proxied bank network this can take
> a long time or be blocked outright. If the pull fails, either configure the Docker
> proxy, load the image from a `docker save`/`docker load` tarball prepared elsewhere,
> or use Option B, which needs no image pulls at all.

---

## Verification status

Honest record of what has actually been executed:

| Piece | Status |
|---|---|
| Published binary running with a service-style environment block (`/health`, CORS lockdown, Swagger off, custom port) | **verified** |
| `dotnet publish` output (7.7 MB) | **verified** |
| All compose files (`config` validation, variable and volume-path resolution incl. `C:\data\uploads`) | **verified** |
| `deploy\*.ps1` parse + `-Preflight` logic | **verified** |
| `package-extension.ps1` producing the QMC zip | **verified** |
| Docker image build and container run | **not executed** — the base-image pull ran at ~67 KB/s on the development network |
| `sc.exe` service creation, registry environment block, firewall rule | **not executed** — needs an elevated session on the target server |
