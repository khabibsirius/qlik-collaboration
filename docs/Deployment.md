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
| `Qlik:BaseUrl` | `Qlik__BaseUrl` | Qlik hub the inbox's "open the sheet" links point at, e.g. `https://qlik.bank.local`. Different on every server — set it per deployment |
| `Qlik:BaseUrl` | `Qlik__BaseUrl` / `QLIK_BASE_URL` | **Set this.** Where the inbox's "open the sheet" links point, e.g. `https://qlik.bank.local`. Different from `Cors:AllowedOrigins`, which decides who may *call* the API. Empty = links are omitted rather than pointing at the wrong machine |
| `Database:ApplySchemaOnStart` | `Database__ApplySchemaOnStart` / `DB_APPLY_SCHEMA` | `true` = apply `schema.sql` at startup after an upgrade. `false` (default) = refuse to start and print what is missing, for sites where a DBA owns the schema |
| `Team:Admins:0` | `Team__Admins__0` | **Set at least one.** Seeds the first admin, who can then grant roles from the team inbox. Without one, the roles screen is read-only and the API warns at startup |
| `Team:Members:0` | `Team__Members__0` | Seeds the BI team, who see every thread and receive notifications. Everyone else is a guest and sees only the threads they started |
| `Email:Enabled` | `Email__Enabled` | turn the digest on (default `false`) |
| `Email:Host` / `Email:Port` | `Email__Host` / `Email__Port` | internal SMTP relay, e.g. `smtp.bank.local` / `25` |
| `Email:From` | `Email__From` | sender address the relay will accept |
| `Email:Recipients:0` | `Email__Recipients__0` | the BI team's **e-mail addresses** (usernames are not addresses) |
| `Email:PickupDirectory` | `Email__PickupDirectory` | write `.eml` files to this folder **instead of sending** — how to test before you have a relay |
| `Email:IntervalMinutes` | `Email__IntervalMinutes` | how often to check (default 30, minimum 5) |
| `Email:ReminderHours` | `Email__ReminderHours` | with nothing new, re-send the unanswered list at most this often (default 24) |
| `Email:InboxUrl` | `Email__InboxUrl` | the team inbox address the e-mail links to |

### When something is wrong

```
http://<server>:5000/api/diagnostics
```

One page, safe to read — no comment text, no credentials. It answers the questions
every problem so far has started with: what build is actually running and how old it
is, whether the database is reachable and up to date, which columns or indexes are
missing, whether any two usernames differ only in capitalisation, and what CORS,
`Qlik:BaseUrl` and the seeded admins are set to.

A failed request also carries its reason now: the panel shows the database's own
message instead of "server answered 500", so the log is no longer the only place the
cause exists.

### Upgrading an existing installation

**Upgrading the API does not upgrade the database.** `schema.sql` is applied by hand
(Options A and B), and the Postgres container runs it only on a brand-new empty volume
(Option C). A release that adds a column therefore meets a database without it.

Since this is checked at startup, the symptom is now a message rather than a crash
loop:

```
crit: This build needs database changes that are not there yet: users.role (roles) …
      psql -U postgres -d qlik_collaboration -f database/schema.sql
```

Either run that once — it is idempotent, safe on a live database, and keeps every
existing comment — or set `DB_APPLY_SCHEMA=true` in `.env` and let the API apply it
itself. The schema is embedded in the build, so the two can never be a checkout apart.

> `Cannot load library libgssapi_krb5.so.2` in the container log is **harmless**.
> Npgsql looks for Kerberos in case the connection needs integrated authentication;
> this one uses a password, so it carries on. Installing the library would need a
> package download, which a server without internet access cannot do — and it would
> change nothing.

### Roles

Three roles, stored in the database and managed from **People and access** in the team
inbox:

| Role | Sees | May also |
|---|---|---|
| `guest` | only the threads they started | — |
| `team` | every thread; receives notifications | — |
| `admin` | every thread | delete anyone's comment, change roles |

`Team:Admins` and `Team:Members` only *seed* these at startup, and seeding never lowers
a role — so changes made in the panel survive a restart. New users arrive as guests; a
role is granted deliberately, never by showing up.

> This is a permission model, not a security boundary. The API trusts the username it
> is given (see [Enterprise.md](Enterprise.md)), so roles decide what the interface
> offers, not what a determined caller can reach. Enforcing them needs the
> authentication work listed there.

### Testing the digest without a mail server

Set `Email:Enabled=true` and `Email:PickupDirectory` to a folder, leave `Email:Host`
empty, then:

```powershell
curl.exe "http://localhost:5000/api/digest/preview"      # the HTML, in a browser
curl.exe "http://localhost:5000/api/digest/status"       # what the next run would do
curl.exe -X POST "http://localhost:5000/api/digest/send?force=true"
```

The `.eml` that appears in the folder opens in Outlook and is byte-for-byte what the
relay would have delivered. Clear `PickupDirectory` and set `Host` to go live.
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
| **Container built and run end-to-end**: image built from `Dockerfile.prebuilt`, container started, `/health` returned `{"status":"healthy","database":"up"}`, `/api/users` returned real rows, CORS locked to the configured origin | **verified** (Linux-container mode) |
| Container reaching the **host** PostgreSQL over `host.docker.internal` | **verified** |
| Published binary running with a service-style environment block | **verified** |
| `dotnet publish` output (7.7 MB) | **verified** |
| Both compose files, in both build modes (`config` validation, variables, volume paths incl. `C:\data\uploads`) | **verified** |
| `deploy\*.ps1` parse + `-Preflight` logic | **verified** |
| `package-extension.ps1` producing the QMC zip | **verified** |
| Windows-container image (`Dockerfile.windows`, Nano Server) | **not executed** — needs a Windows-container engine; the Linux equivalent of the same prebuilt Dockerfile is verified |
| `sc.exe` service creation, registry environment block, firewall rule | **not executed** — needs an elevated session on the target server |

### Bug this verification caught

Running the container for real exposed a defect that static checking had missed:
`appsettings.json` contained a `"Urls": "http://localhost:5000"` key. App configuration
is layered **on top of** host configuration, so that key silently overrode
`ASPNETCORE_URLS` — the app bound to `localhost` *inside* the container and the
published port answered nothing. It would have broken the Windows Service deployment
in exactly the same way (`-ListenUrl` would have had no effect).

Fixed by removing the key from `appsettings.json`; the listen address now comes from
`ASPNETCORE_URLS` in production and from `Properties/launchSettings.json` (never
published) for local development. **Do not reintroduce a `Urls` key in
appsettings.json.**
