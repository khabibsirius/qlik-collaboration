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
   AD identity (`UserDirectory=BANK; UserId=ivanov`) and the name field is
   auto-filled and locked. Users never type their name. (On Desktop the
   directory is `Personal`, so the field stays editable — dev mode.)

## How the team experiences it

- Open any sheet that has the panel → see the sheet's discussion.
- Write comments, reply, @mention colleagues by AD name (autocomplete grows
  automatically as people participate), attach files/voice, set statuses.
- A mention/reply lights up the 🔔 with an unread badge the next time the
  mentioned person has the panel open — instantly if they're online (SignalR).
- "📎 apply filters" reproduces the exact selections the author had — the
  core analytical-context feature.

## Production hardening checklist (before wide rollout)

| Item | Now (pilot) | Production |
|---|---|---|
| Identity trust | client-sent (auto-filled from Qlik, but not signed) | JWT validated server-side against Qlik Proxy / AD |
| CORS | allow all origins | restrict to the Qlik Sense host |
| Transport | http/ws | https/wss (certificates) |
| DB credentials | in appsettings.json | environment variables / secret store |
| Backend hosting | `dotnet run` | Windows Service or IIS, auto-start, logging |
| Attachments | local folder | dedicated share/storage with backup, antivirus scan hook |
