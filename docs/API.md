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
  "objectId": null,          // optional: Qlik object id (Etap 5)
  "parentId": null,          // optional: reply to comment id
  "author": "Diyorbek",
  "body": "text",
  "selectionState": "[{\"field\":\"Bank\",\"values\":[\"NBU\"]}]"   // optional JSON string (Etap 6)
}
```

Returns `201` with the created comment.

## DELETE /api/comments/{id}?author=

Soft delete; only succeeds if `author` matches (Desktop trust model — replaced by JWT identity on Enterprise). `204` or `404`.

## PUT /api/comments/{id}/status

```json
{ "status": "in_progress" }   // new | in_progress | fixed | closed
```

Returns the updated comment.

## Planned

- `POST /api/comments/{id}/attachments` — file upload (Etap 3)
- `GET /api/notifications?user=` — mentions & replies (Etap 2)
- SignalR hub `/hubs/comments` — real-time push replacing polling
