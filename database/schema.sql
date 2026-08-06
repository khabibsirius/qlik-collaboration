-- =============================================================
-- Qlik Collaboration — PostgreSQL schema
-- Designed to cover MVP (Etap 1) through object/selection-bound
-- comments (Etaps 5–6) without structural rewrites.
-- =============================================================

-- Users. On Qlik Sense Desktop there is no authentication, so users
-- self-identify with a display name. When moving to Enterprise this
-- table maps to the Qlik Proxy / AD identity (username = DOMAIN\user).
CREATE TABLE IF NOT EXISTS users (
    id             SERIAL PRIMARY KEY,
    username       TEXT NOT NULL UNIQUE,
    display_name   TEXT NOT NULL,
    -- Qlik UserDirectory the identity came from ('BANK' on Enterprise/AD,
    -- 'Personal' on Desktop, NULL for manually typed dev names). Audit trail:
    -- shows which comments came from a real authenticated identity.
    user_directory TEXT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Comments. One table handles all binding levels:
--   sheet-level comment  : no rows in comment_objects
--   object-level comment : rows in comment_objects (Etap 5, many-to-many)
--   selection context    : selection_state JSONB snapshot (Etap 6)
--   replies              : parent_id -> comments.id (one level, like Teams)
CREATE TABLE IF NOT EXISTS comments (
    id              SERIAL PRIMARY KEY,
    app_id          TEXT NOT NULL,
    sheet_id        TEXT NOT NULL,
    parent_id       INTEGER NULL REFERENCES comments(id) ON DELETE CASCADE,
    author          TEXT NOT NULL,
    body            TEXT NOT NULL,
    selection_state JSONB NULL,          -- [{ "field": "Bank", "values": ["NBU"] }, ...]
    status          TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'in_progress', 'fixed', 'closed')),  -- Etap 4
    is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,   -- soft delete keeps reply threads intact
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NULL
);

-- Roles. 'guest' is the default and the safe one: an executive who has opened a
-- dashboard sees only the threads they started themselves.
--   guest — sees only their own threads
--   team  — sees every thread; the audience notifications are sent to
--   admin — team, plus may delete anyone's comment and change other people's roles
--
-- Written as ALTER rather than only in CREATE TABLE above, because a server that is
-- already running has the table and would skip CREATE TABLE IF NOT EXISTS entirely —
-- re-running this file has to upgrade it, not silently do nothing.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'guest';
DO $$
BEGIN
    ALTER TABLE users ADD CONSTRAINT users_role_check
        CHECK (role IN ('admin', 'team', 'guest'));
EXCEPTION
    WHEN duplicate_object THEN NULL;   -- already applied on a previous run
END $$;

CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

-- Names differing only in case are the same person. Qlik reports one casing, and a
-- Team:Admins entry written by hand may use another; without this the seeder inserts
-- a SECOND row and the role lookup — which matches case-insensitively — then finds
-- both and returns whichever the planner happens to yield first. The symptom is
-- being configured as an admin and still treated as a guest, intermittently.
DO $$
BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (lower(username));
EXCEPTION
    WHEN unique_violation THEN
        RAISE WARNING
            'users already holds names differing only in case. Merge them (keep the '
            'spelling Qlik reports), then re-run this file to add the unique index.';
END $$;

CREATE INDEX IF NOT EXISTS idx_comments_app_sheet ON comments (app_id, sheet_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent    ON comments (parent_id);

-- The team inbox lists work from every app at once, where an app id is a GUID on
-- Enterprise and a .qvf path on Desktop — neither tells you which dashboard is
-- meant. The extension knows the titles, so it sends them and they are stored with
-- the comment. Nullable: rows written before this, and any client that cannot read
-- the titles, fall back to showing the ids.
ALTER TABLE comments ADD COLUMN IF NOT EXISTS app_name   TEXT NULL;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS sheet_name TEXT NULL;

-- The inbox's main query: open threads across all apps, newest activity first.
CREATE INDEX IF NOT EXISTS idx_comments_open
    ON comments (status, created_at DESC)
    WHERE parent_id IS NULL AND is_deleted = FALSE;

-- Etap 5: which sheet objects a comment is attached to (0..n per comment).
CREATE TABLE IF NOT EXISTS comment_objects (
    comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    object_id  TEXT NOT NULL,
    PRIMARY KEY (comment_id, object_id)
);

CREATE INDEX IF NOT EXISTS idx_comment_objects_object ON comment_objects (object_id);

-- ---------- Future phases (created now so the API can grow into them) ----------

-- Etap 3: file attachments (files stored on disk/object storage, path here)
CREATE TABLE IF NOT EXISTS attachments (
    id           SERIAL PRIMARY KEY,
    comment_id   INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    file_name    TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes   BIGINT NOT NULL,
    storage_path TEXT NOT NULL,
    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- DEPRECATED. @mentions were removed: the discussion is a single shared thread,
-- so every comment reaches the whole team and nothing is addressed at one person.
-- The table is still created so existing databases and their rows stay valid;
-- nothing writes to it any more, and it can be dropped once no history is needed.
CREATE TABLE IF NOT EXISTS mentions (
    id                 SERIAL PRIMARY KEY,
    comment_id         INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    mentioned_username TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Etap 2: notifications (in-app; email/Teams delivery handled by backend workers).
-- One row per (recipient, comment): a new comment produces one for every known
-- user except its author.
CREATE TABLE IF NOT EXISTS notifications (
    id         SERIAL PRIMARY KEY,
    username   TEXT NOT NULL,
    comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    -- 'comment' | 'reply' | 'status_change'
    -- ('mention' and 'broadcast' appear in rows written before @mentions were removed)
    kind       TEXT NOT NULL,
    is_read    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (username, is_read);

-- One row per digest e-mail actually sent. The next digest reports what happened
-- since the last row, which is what stops a digest every 30 minutes from repeating
-- the same unanswered comment until the team filters the sender into a folder.
CREATE TABLE IF NOT EXISTS digest_runs (
    id        SERIAL PRIMARY KEY,
    sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- what went out, for answering "why did I get this?" without a mail server log
    new_items INTEGER NOT NULL DEFAULT 0,
    waiting   INTEGER NOT NULL DEFAULT 0,
    recipients TEXT NOT NULL DEFAULT ''
);
