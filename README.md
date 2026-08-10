# Qlik Collaboration

Комментарии и обсуждения прямо в Qlik Sense — панель-расширение с привязкой комментариев к листу, объекту и выборкам (selection state).

```
qlik-collaboration/
├── backend/     ASP.NET Core 8 REST API  (QlikCollaboration.Api)
├── extension/   Qlik Sense extension     (qlik-collaboration)
├── database/    PostgreSQL schema        (schema.sql)
└── docs/        Architecture, API, Install
```

## Quick start (Qlik Sense Desktop)

1. **Database** — PostgreSQL 16, база `qlik_collaboration`, схема из `database/schema.sql`.
2. **Backend** — `dotnet run --project backend/QlikCollaboration.Api` → `http://localhost:5000` (Swagger: `/swagger`).
3. **Extension** — скопировать папку `extension/qlik-collaboration` в `Documents\Qlik\Sense\Extensions`.
4. В Qlik Sense Desktop: редактирование листа → Custom objects → **Qlik Collaboration** → перетащить на лист (правая часть).

Подробно: [docs/Install.md](docs/Install.md)

## Возможности (MVP)

- ✅ Комментарии к текущему листу, автор, время
- ✅ Ответы (reply)
- ✅ Удаление своих комментариев (soft delete)
- ✅ Статусы: New / In progress / Fixed / Closed
- ✅ Привязка комментария к объекту листа (picker)
- ✅ Захват текущих выборок + «📎 apply filters» — открывает контекст комментария
- ✅ Обновление без перезагрузки (polling; SignalR — в плане)

## Roadmap

| Этап | Что | Статус |
|---|---|---|
| 1 | MVP: комментарии, ответы, удаление | ✅ |
| 2 | @mentions + уведомления (🔔, кликабельные, broadcast всей команде) | ✅ |
| 3 | Вложения: файлы, изображения, 🎤 голосовые | ✅ |
| 4 | Статусы | ✅ |
| 5 | Привязка к объектам (мульти, click-to-pick 🎯) | ✅ |
| 6 | Привязка к выборкам (захват + восстановление) | ✅ |
| — | SignalR real-time (+polling как fallback) | ✅ |
| — | JWT / AD auth (Enterprise) | план |
