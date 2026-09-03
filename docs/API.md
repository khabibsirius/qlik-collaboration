# REST API

Base URL (dev): `http://localhost:5000` · Swagger UI: `/swagger`

## Who can see what

A discussion is **private** unless an admin says otherwise. Private is the default
everywhere and needs nothing configured.

**Private** — two kinds of user, decided by the role in the `users` table
(seeded from `Team:Members` / `Team:Admins`, managed at `/admin`):

- **BI team** (`team` / `admin`) — sees every thread.
- **Everyone else** (the executives the dashboards are built for) — sees only the
  threads **they started**, plus the replies in them. Two executives never read
  each other's feedback.

The unit of visibility is the *thread*, not the message: a reply belongs to
whoever started the thread. A thread started by a team member is therefore
internal — guests do not see it.

**Public** — everyone who can open the sheet sees the whole discussion, and can
`@mention` colleagues. Set per app, and per sheet inside it: the sheet's own
setting wins, otherwise the app's, otherwise private. See
[`/api/visibility`](#get-apivisibility).

@mentions are written **only** on a public discussion. A notification carries an
80-character excerpt of the comment, so mentioning someone who cannot open the
thread would hand them the text through the bell; the API refuses to, whatever the
panel offers. A mention never replaces the team broadcast — it upgrades that
person's notification from `comment` to `mention` and nothing else.

An empty `Team:Members` means everyone is a guest, which is the safe direction to
fail; the API logs a warning at startup when it is empty.

> This is not a security boundary. Like the rest of this API it trusts the
> username it is given, so it prevents disclosure **by the UI**, not by someone
> calling the API directly with another name. Real enforcement needs the JWT work
> in [Enterprise.md](Enterprise.md).

## GET /api/comments?appId=&sheetId=&user=[&objectId=]

Non-deleted comments for a sheet (including replies), oldest first, filtered to
what `user` may see. **`user` is required** — without it the response is `[]`,
so a client that forgets it shows nothing rather than everything.

```json
[
  {
    "id": 1,
    "appId": "C:\\Users\\me\\Documents\\Qlik\\Sense\\Apps\\Portfolio.qvf",
    "sheetId": "aBcDeF",
    "objectId": null,
    "parentId": null,
    "author": "Diyorbek",
    "body": "Есть подозрение на ошибку в данных.",
    "selectionState": "[{\"field\": \"Bank\", \"values\": [\"NBU\"]}]",
    "status": "new",
    "isDeleted": false,
    "createdAt": "2026-08-05T05:33:50Z",
    "updatedAt": null
  }
]
```

## POST /api/comments

```json
{
  "appId": "…", "sheetId": "…",
  "objectIds": ["BAR_e108", "PIE_cb82"],   // optional: Qlik object ids (Etap 5)
  "parentId": null,                        // optional: reply to comment id
  "author": "ivanov",
  "authorDirectory": "BANK",               // optional: Qlik UserDirectory, audit only
  "body": "text",
  "selectionState": "[{\"field\":\"Bank\",\"values\":[\"NBU\"]}]"   // optional JSON string (Etap 6)
}
```

Returns `201` with the created comment.

**Notification routing** — a comment notifies exactly the people allowed to read
its thread: the BI team (`Team:Members`), plus whoever started the thread. Never
the author of the comment itself.

| Recipient | `kind` |
|---|---|
| the person who started the thread | `reply` |
| the BI team | `comment` |

Notifying every registered user would tell one executive that another had
commented, and the 80-character excerpt would say what about. Notifications
written before @mentions were removed keep their old `mention` / `broadcast`
kinds and still render.

## DELETE /api/comments/{id}?author=

Soft delete; only succeeds if `author` matches (Desktop trust model — replaced by JWT identity on Enterprise). `204` or `404`.

## PUT /api/comments/{id}/status

```json
{ "status": "in_progress" }   // new | in_progress | fixed | closed
```

Returns the updated comment.

## GET /api/visibility

Every app and sheet that has comments, with the setting governing it — not only the
rows already configured, so a dashboard can be found here before anyone has set it.

```json
[ { "appId": "c8f2…", "appName": "Sales", "comments": 42,
    "setting": "public", "effective": true, "setBy": "ivanov", "setAt": "…",
    "sheets": [ { "sheetId": "hJk…", "sheetName": "Margins", "comments": 12,
                  "setting": "inherit", "effective": true } ] } ]
```

`setting` is `default` / `public` / `private` for an app, and `inherit` / `public` /
`private` for a sheet. `effective` is what actually applies once the app-wide value
is taken into account.

## GET /api/visibility/resolve?appId=&sheetId=

What applies to one sheet, and which level decided it. No role needed — the panel
calls it on load to know whether to offer the @ button.

```json
{ "isPublic": true, "source": "sheet" }
```

`source` is `sheet`, `app` or `default`.

## PUT /api/visibility

Admin only (403 otherwise). Omit `sheetId` to set the app-wide default.

```json
{ "appId": "c8f2…", "sheetId": "hJk…", "isPublic": true, "by": "ivanov" }
```

## DELETE /api/visibility?appId=&sheetId=&by=

Admin only. Removes a setting so the level above decides again: clearing a sheet
returns it to its app, clearing an app returns it to private. `404` when there was
nothing set at that level — which is the state being asked for anyway.

## GET /api/users

Everyone the team knows about — the audience every comment is broadcast to. Returns `["Ivan", "khabib"]`.

## POST /api/users

```json
{ "username": "ivanov", "userDirectory": "BANK" }   // userDirectory optional, audit only
```

Announces a user who has opened the panel, so they join the notification audience
without having to post first. Idempotent; returns `204`.

## GET /api/inbox?includeClosed=false

The team's work queue: open threads across **every** app, newest activity first
(max 200). Replies are folded into their parent — the unit of work is the thread,
not the message.

```json
[{ "id": 13, "appId": "…", "sheetId": "…",
   "appName": "Credit Portfolio", "sheetName": "Overview",
   "author": "director.rakhimov", "body": "…", "status": "new",
   "createdAt": "…", "replyCount": 0, "lastActivityAt": "…" }]
```

`replyCount: 0` is the signal the queue exists for — feedback nobody has answered.
`appName`/`sheetName` are null for comments written before titles were captured, or
when the client could not read them; fall back to the ids.

`includeClosed=true` returns closed threads as well.

## GET /api/inbox/{id}/replies

The replies of one thread, oldest first — fetched when a row is expanded.

## GET /api/digest/preview · /api/digest/preview.txt · /api/digest/status

The digest e-mail as it stands right now — HTML, plain text, or what the next run
would decide. Nothing is sent and nothing is recorded, so these are safe to open at
any time.

```json
{ "lastSent": "…", "newItems": 2, "waiting": 5, "wouldSend": true }
```

## POST /api/digest/send?force=false

Sends now instead of waiting for the timer, and returns what it did. Without
`force`, the same rule the timer uses applies: send when something has been
written since the last digest, and at most once every `Email:ReminderHours` when
nothing is new but comments are still unanswered. `force=true` ignores that rule,
which is how a mail configuration is tested against a quiet database.

```json
{ "result": "sent to 2 recipient(s): 2 new, 5 waiting" }
{ "result": "nothing new; reminder not due for another 21.4h" }
```

## GET /api/config

Settings the inbox page needs at runtime, so one build serves every deployment:

```json
{ "qlikBaseUrl": "http://localhost:4848" }
```

## GET /api/notifications?user=

Latest 50 notifications for a user, newest first:

```json
[{ "id": 1, "kind": "comment", "isRead": false, "createdAt": "…", "commentId": 13,
   "fromAuthor": "Ivan", "excerpt": "please check this", "appId": "…", "sheetId": "…" }]
```

Each notification carries `commentId`, `appId` and `sheetId` — everything the panel
needs to jump to the comment when the user clicks it.

## PUT /api/notifications/read?user=

Marks all of the user's notifications as read. `204`.

## PUT /api/notifications/{id}/read?user=

Marks one notification as read (used when the user opens it). Scoped by username,
so one user cannot clear another's notifications — `404` if it isn't theirs.

## POST /api/comments/{id}/attachments

`multipart/form-data` with a `file` field. Max 25 MB. Allowed: pdf, xlsx, xls, docx, doc,
pptx, csv, txt, png, jpg, jpeg, gif, webm, ogg, mp3, m4a, wav, zip. Voice messages are
`.webm` audio attachments. Files stored on disk (`Storage:AttachmentsPath`, default
`uploads/` next to the API), metadata in PostgreSQL.

## GET /api/attachments/{id}

Downloads the file (supports range requests, so `<audio>`/`<img>` can stream).

## SignalR hub /hubs/comments

Server → client events (connect with `skipNegotiation: true`, WebSocket transport):

- `commentsChanged` `{appId, sheetId}` — anything changed on that sheet; clients re-fetch
- `notify` `{username}` — that user has a new notification

The extension keeps polling as a safety net: 3s without SignalR, 30s with it.
