# Deployment on Qlik Sense Enterprise on-premise (team usage)

How the module works for a whole team once it moves from Desktop to the company's
Qlik Sense Enterprise server.

## Topology

```
User A (browser) ─┐
User B (browser) ─┼─► Qlik Sense Enterprise server        ← extension lives here (QMC import)
User C (browser) ─┘          │
        │                    │ (users are AD-authenticated by Qlik Proxy)
        │
        └───────────────────► Collaboration backend server  ← one instance for everyone
                                 ├─ ASP.NET Core API + SignalR   (e.g. :5000)
                                 ├─ PostgreSQL (qlik_collaboration)
                                 └─ uploads/ folder (attachments)
```

- The backend can run on the Qlik server itself or any Windows server with the
  .NET 8 runtime. One instance serves the whole team.
- All users hitting the same API = everyone sees the same comments per sheet,
  with SignalR pushing changes to all open clients instantly.

## Multi-node Qlik Sense: where each piece goes

The collaboration backend is **not** part of the Qlik cluster. It does not care how
many Qlik nodes exist, and Qlik does not manage it. Rule of thumb: **the extension
goes into Qlik, everything else stays outside it.**

```
                        ┌──────────── Qlik Sense cluster ────────────┐
User workstations       │  Central node   (Repository, QMC)          │
   (browsers)  ─────────►  RIM node #1    (Proxy + Engine)           │  extension is
        │               │  RIM node #2    (Proxy + Engine)           │  imported ONCE
        │               │  Scheduler node (Reloads)                  │  via QMC and
        │               │  Qlik repository DB (PostgreSQL :4432)     │  auto-syncs to
        │               └────────────────────────────────────────────┘  all nodes
        │
        └──────────────► Collaboration app server  (NOT a Qlik node)
                            ├─ .NET 8 runtime + QlikCollaboration.Api (Windows Service)
                            └─ attachments folder
                                       │
                                       ▼
                         PostgreSQL  (bank's existing managed instance,
                                      or installed on the app server)
```

| Component | Where to install | Why |
|---|---|---|
| **Extension** | Nowhere manually — QMC → Extensions → Import on the **central node** | The repository distributes it to every RIM node automatically. Never copy files to nodes by hand: a node re-sync will overwrite them. |
| **.NET 8 runtime + API** | **One** server outside the Qlik cluster (a small VM: 2 vCPU / 4 GB is plenty) | Keeps Qlik nodes untouched (bank change-control, Qlik upgrades, support). One instance = one source of truth for comments and one SignalR hub. |
| **PostgreSQL** | The bank's **existing managed PostgreSQL** (just a new `qlik_collaboration` database), or on the app server if none is available | DBA-managed backups, monitoring and HA come for free. |
| **Attachments folder** | Local disk of the app server (or a file share) | Must be backed up — files live on disk, only metadata is in the DB. |

### Hard rules

1. **Do NOT use Qlik's own PostgreSQL** (the repository database on port `4432`).
   It is Qlik-internal; putting application tables there is unsupported and Qlik
   upgrades can change or lock it. Our own PostgreSQL on `5432` coexists fine, but
   a separate instance/server is cleaner.
2. **Run exactly ONE instance of the backend.** SignalR keeps connections in memory;
   two instances behind a load balancer would each broadcast to only half the users.
   If HA is ever required, add a Redis backplane (`AddSignalR().AddStackExchangeRedis(...)`)
   — a config change, not a redesign.
3. **Do NOT install the backend on a RIM node.** RIM nodes are added/removed/rebuilt
   as user load changes; the service would silently disappear with the node.
4. **The API must be reachable from user workstations, not just from the Qlik
   servers.** The extension is client-side JavaScript — the browser makes the calls.
   So: a DNS name (`bi-collab.bank.local`), firewall open from the user subnet, and
   **HTTPS/WSS if Qlik Sense is on HTTPS** (browsers block mixed content).

### Which node do users hit?

Irrelevant to us. A user may be load-balanced onto RIM node #1 and their colleague
onto node #2 — both browsers still call the same collaboration API, so both see the
same comments and the same real-time updates. The Qlik cluster topology is invisible
to the module.

### Central node vs separate VM

If getting a new VM takes months, installing on the **central node** works technically
(spare CPU is usually available and the service is lightweight). Trade-offs to state
openly: any Qlik maintenance/reboot takes comments offline with it, and the bank's
change control now covers a non-Qlik service on a Qlik server. A separate VM is the
recommendation; the central node is the acceptable shortcut for a pilot.

## Step-by-step

1. **Backend server**
   - Install .NET 8 (runtime is enough), PostgreSQL.
   - `psql -f database/schema.sql` into a `qlik_collaboration` database.
   - Set the connection string + `Storage:AttachmentsPath` in `appsettings.json`.
   - Run as a Windows Service or in IIS (`dotnet publish`, then host).
2. **Extension**
   - Zip the `extension/qlik-collaboration/` folder.
   - QMC → Extensions → Import.
   - In each app: edit sheet → Custom objects → Qlik Collaboration → set
     **Backend API URL** to the backend server (e.g. `http://bi-collab:5000`).
3. **QMC → Content Security Policy** (the #1 gotcha — without this, Enterprise
   silently blocks the extension's network calls):
   - Add an entry for the backend origin with directives:
     `connect-src http://bi-collab:5000 ws://bi-collab:5000`
4. **Identity — automatic.** The extension calls
   `app.global.getAuthenticatedUser()`; on Enterprise this returns the real
   AD identity (`UserDirectory=BANK; UserId=ivanov`). The name input is replaced
   by a read-only identity row (avatar + name + 🔒) — users never type a name and
   cannot post as someone else. The directory is stored in `users.user_directory`
   as an audit trail of which identities are genuinely authenticated.

   The **User identity** setting in the object's properties controls this:

   | Mode | Behaviour |
   |---|---|
   | `auto` (default) | Qlik identity when it is a real one; manual entry on Desktop (`UserDirectory=Personal`) |
   | `qlik` | Always the Qlik identity, never a typed name. If Qlik cannot be asked, commenting is blocked with an error rather than falling back. **Set this for the rollout.** |
   | `manual` | Typed name — development only |

   Honest limit for the pilot: the identity is chosen by the client, and the API
   trusts what it is sent. A user who bypasses the panel and calls the API directly
   could still claim another name. Closing that requires server-side validation
   (JWT / Qlik session check) — see the hardening table below.

## How the team experiences it

- The panel starts **collapsed to a 💬 bubble** carrying the unread count, and expands
  over the sheet when clicked, so a dashboard is not covered until someone asks for the
  discussion. **Drag the bubble** to park it anywhere — beside the toolbar, in a corner —
  and it stays there for that user. The expanded panel opens next to it, growing into
  whichever side has room.
- Both the bubble and the panel float above the sheet, so the object's own cell holds
  nothing. Put it in a **small cell** out of the way; while the panel is floating the
  extension makes that cell's white Qlik box transparent, so it does not show up as an
  empty rectangle on the dashboard.
- "Panel display → Docked" in the properties panel restores the old always-open
  behaviour, and the panel falls back to docked by itself while a sheet is being edited,
  or on a client where `position: fixed` is anchored to the cell rather than the window.
- Open any sheet that has the panel → see the discussion you are entitled to. The
  **BI team** (`Team:Members` in the API's configuration) sees every thread on the
  sheet. **Everyone else** — the executives the dashboards are built for — sees only
  the threads they started themselves, so two of them never read each other's
  feedback. Every comment carries its author's AD name.
- The **team inbox** (`/` on the API host) shows every thread from every app and does
  **not** filter by user. It is a tool for the BI team: restrict it at the reverse
  proxy or firewall, and do not hand the URL to the executives.
- Write comments, reply, attach files/voice, set statuses.
- **Every comment notifies the whole team** — the 🔔 gets an unread badge the next
  time a colleague has the panel open, instantly if they are online (SignalR).
  Nobody has to open a sheet to discover that something was said about it.
- Opening the panel is enough to join that audience; a colleague who only reads
  still gets notified, without having to post first.
- **Clicking a notification opens the comment**: on the same sheet it scrolls to
  it and flashes it green; on another sheet Qlik navigates there and the panel
  highlights the comment on arrival. Opening a notification marks it read.
- "📎 apply filters" reproduces the exact selections the author had — the
  core analytical-context feature.

## Production hardening checklist (before wide rollout)

### Known limitations to close before a bank-wide rollout

Found by an adversarial review of the code; each is a deliberate pilot-scope decision,
not an unknown:

1. **Notifications ignore Qlik's access rules.** Every comment notifies every user in
   the `users` table, and the notification carries an 80-character excerpt of the
   comment plus its app id — even to people who have no access to that app or stream
   in Qlik. For a pilot inside one team this is fine; before opening the module to
   several departments, the audience must be filtered by who can actually open the app
   (QRS API check, or scope it to users who have already participated in that app).
2. **The API trusts `?user=` and the posted author name.** Anyone who can reach the
   API can read or clear another user's notifications, or post under another name.
   Only the panel UI is locked down. Closing this is the JWT item below.
3. **Identity is keyed on the bare Qlik `UserId`.** Two Qlik user directories that
   contain the same UserId would collapse into one account. Fine for one AD domain;
   revisit if the bank has several.
4. **The panel needs the sheet view.** `getCurrentSheetId()` fails in embedded /
   single-object contexts, where the panel falls back to one shared thread.

| Item | Now (pilot) | Production |
|---|---|---|
| Identity trust | client-sent (auto-filled from Qlik, but not signed) | JWT validated server-side against Qlik Proxy / AD |
| CORS | allow all origins | restrict to the Qlik Sense host |
| Transport | http/ws | https/wss (certificates) |
| DB credentials | in appsettings.json | environment variables / secret store |
| Backend hosting | `dotnet run` | Windows Service or IIS, auto-start, logging |
| Attachments | local folder | dedicated share/storage with backup, antivirus scan hook |
