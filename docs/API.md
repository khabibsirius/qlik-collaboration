# REST API

Base URL (dev): `http://localhost:5000` · Swagger UI: `/swagger`

## GET /api/comments?appId=&sheetId=[&objectId=]

All non-deleted comments for a sheet (including replies), oldest first.

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

**Notification routing** — who gets notified by this comment:

| Comment contains | Who is notified | `kind` |
|---|---|---|
| `@name` of known users | only those users | `mention` |
| nothing (a reply) | the parent comment's author | `reply` |
| no `@mention` at all | **everyone except the author** | `broadcast` |

A comment addressed to nobody in particular is team-wide news, so it reaches the
whole team — otherwise it would reach nobody until someone happened to open the
sheet. Turn it off with `Notifications:BroadcastWhenNoMention: false` in
`appsettings.json` (then only mentions and replies notify).

## DELETE /api/comments/{id}?author=

Soft delete; only succeeds if `author` matches (Desktop trust model — replaced by JWT identity on Enterprise). `204` or `404`.

## PUT /api/comments/{id}/status

```json
{ "status": "in_progress" }   // new | in_progress | fixed | closed
```

Returns the updated comment.

## GET /api/users

All known users (everyone who has commented) — feeds @mention autocomplete. Returns `["Ivan", "khabib"]`.

## GET /api/notifications?user=

Latest 50 notifications for a user (mentions + replies), newest first:

```json
[{ "id": 1, "kind": "mention", "isRead": false, "createdAt": "…", "commentId": 13,
   "fromAuthor": "Ivan", "excerpt": "@khabib please check this", "appId": "…", "sheetId": "…" }]
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
