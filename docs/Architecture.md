# Architecture

```
┌────────────────────────────┐
│  Qlik Sense client         │
│  ┌──────────────────────┐  │
│  │ qlik-collaboration    │  │   Capability API:
│  │ (extension, JS/jQuery)│──┼──▶ app id, sheet id,
│  └──────────┬───────────┘  │    selectionState, objects
└─────────────┼──────────────┘
              │ REST (fetch, polling)          [upgrade path: SignalR/WebSocket]
              ▼
┌────────────────────────────┐
│  QlikCollaboration.Api     │   ASP.NET Core 8 + Dapper
│  http://localhost:5000     │   CORS open (dev) → JWT+AD (Enterprise)
└─────────────┬──────────────┘
              ▼
┌────────────────────────────┐
│  PostgreSQL 16             │   qlik_collaboration
│  comments, users,          │
│  attachments, mentions,    │
│  notifications             │
└────────────────────────────┘
```

## Context detection — how the extension knows "where" a comment belongs

This is the technically interesting part (and the risk everyone warns about). All of it is
**supported Capability API**, no DOM hacks:

| Context | API | Notes |
|---|---|---|
| App id | `qlik.currApp(this).id` | On Desktop this is the .qvf path; on Enterprise a GUID. Both are stable string keys. |
| Sheet id | `qlik.navigation.getCurrentSheetId()` | `{success, sheetId}` |
| Current selections | `app.selectionState()` + `OnData` event | Fires on every selection change; gives `[{fieldName, selectedValues}]`. Serialized to `comments.selection_state` (jsonb). |
| Objects on sheet | `app.getObjectProperties(sheetId).properties.cells` | Feeds the "attach to object" picker → `comments.object_id`. |
| Re-apply selections | `app.clearAll()` + `app.field(f).selectValues([...])` | "📎 apply filters" on a comment restores the exact analytical context. |

**Known limitation:** an extension cannot natively receive click events on *other* charts.
The MVP therefore uses an explicit object picker. A DOM-level click listener on sheet cells
is possible as a later enhancement, but it relies on undocumented markup and must never be
a structural dependency.

## Desktop → Enterprise migration

Everything is designed so nothing is rewritten when moving to Qlik Sense Enterprise:

| Concern | Desktop (now) | Enterprise (later) |
|---|---|---|
| Auth | none; author = self-entered name (localStorage) | Qlik Proxy header / JWT; `users` table maps to AD identity |
| Extension deploy | copy folder to `Documents\Qlik\Sense\Extensions` | import zip via QMC |
| CORS | allow-all | restrict to Qlik host; content security policy allowlist for the API origin |
| Real-time | polling (3s) | SignalR hub (`/hubs/comments`), broadcast on create/delete/status |
| DB | localhost PostgreSQL | server PostgreSQL, same schema |

## Design decisions

- **Dapper over EF Core** — explicit SQL is auditable (bank environment), schema lives in
  `database/schema.sql` under DBA control.
- **Soft delete** (`is_deleted`) — keeps reply threads intact and gives an audit trail.
- **One `comments` table for all binding levels** — sheet (`object_id IS NULL`), object,
  and selection context (`selection_state jsonb`). No schema change needed for Etap 5–6.
- **Polling isolated in one function** (`refresh()` in the extension) — swapping to
  SignalR touches one place.
