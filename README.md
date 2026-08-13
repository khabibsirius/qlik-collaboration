# Qlik Collaboration

Комментарии и обсуждения прямо в Qlik Sense — панель-расширение с привязкой комментариев к листу, объекту и выборкам (selection state).

```
qlik-collaboration/
├── backend/     ASP.NET Core 8 REST API + SignalR  (QlikCollaboration.Api)
├── extension/   Qlik Sense extension               (qlik-collaboration)
├── database/    PostgreSQL schema                  (schema.sql)
├── deploy/      Windows Service installer, extension packaging
└── docs/        Architecture, API, Install, Deployment, Enterprise
```

## Deploy

```bash
cp .env.example .env          # set POSTGRES_PASSWORD and QLIK_ORIGIN
docker compose up -d --build  # API on :5000, PostgreSQL with the schema applied
```

No Docker on the target Windows Server? Use the service installer instead:

```powershell
.\deploy\install-windows-service.ps1 -DbHost pg.bank.local -DbPassword '<pwd>' -QlikOrigin https://qlik.bank.local
```

Both paths, plus HTTPS, backups and sizing: [docs/Deployment.md](docs/Deployment.md).

## Quick start (Qlik Sense Desktop)

1. **Database** — PostgreSQL 16, база `qlik_collaboration`, схема из `database/schema.sql`.
2. **Backend** — `dotnet run --project backend/QlikCollaboration.Api` → `http://localhost:5000` (Swagger: `/swagger`).
3. **Extension** — скопировать папку `extension/qlik-collaboration` в `Documents\Qlik\Sense\Extensions`.
4. В Qlik Sense Desktop: редактирование листа → Custom objects → **Qlik Collaboration** → перетащить на лист (правая часть).

Подробно: [docs/Install.md](docs/Install.md)

## Возможности (MVP)

- ✅ Комментарии к текущему листу, автор, время — общий чат: личных сообщений нет, все видят всё
- ✅ Ответы (reply)
- ✅ Удаление своих комментариев (soft delete)
- ✅ Статусы: New / In progress / Fixed / Closed
- ✅ Привязка комментария к объекту листа (picker)
- ✅ Захват текущих выборок + «📎 apply filters» — открывает контекст комментария
- ✅ Обновление без перезагрузки (polling; SignalR — в плане)
- ✅ **Team inbox** — `http://<сервер>:5000/` — все открытые обсуждения по всем
  приложениям в одном списке: кто написал, ответили ли уже, статус, ссылка на лист
- ✅ **Дайджест на почту (Outlook)** — письмо команде: что нового и что осталось
  без ответа. Приходит только когда есть новое; «висяки» напоминаются раз в сутки.
  Проверяется без почтового сервера — письмо пишется в папку как `.eml`
- ✅ **Свёрнутый режим** — панель по умолчанию свёрнута в кружок 💬 со счётчиком
  непрочитанных; по клику разворачивается поверх листа. Объект на листе нужно
  сделать маленьким (≈60×60): расширение не может менять размер своей ячейки

## Roadmap

| Этап | Что | Статус |
|---|---|---|
| 1 | MVP: комментарии, ответы, удаление | ✅ |
| 2 | Уведомления 🔔 всей команде о каждом комментарии (кликабельные) | ✅ |
| 3 | Вложения: файлы, изображения, 🎤 голосовые | ✅ |
| 4 | Статусы | ✅ |
| 5 | Привязка к объектам (мульти, click-to-pick 🎯) | ✅ |
| 6 | Привязка к выборкам (захват + восстановление) | ✅ |
| — | SignalR real-time (+polling как fallback) | ✅ |
| — | JWT / AD auth (Enterprise) | план |
