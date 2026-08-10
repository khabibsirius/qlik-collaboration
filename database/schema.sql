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

CREATE INDEX IF NOT EXISTS idx_comments_app_sheet ON comments (app_id, sheet_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent    ON comments (parent_id);

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

-- Etap 2: @mentions
CREATE TABLE IF NOT EXISTS mentions (
    id                 SERIAL PRIMARY KEY,
    comment_id         INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    mentioned_username TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Etap 2: notifications (in-app; email/Teams delivery handled by backend workers)
CREATE TABLE IF NOT EXISTS notifications (
    id         SERIAL PRIMARY KEY,
    username   TEXT NOT NULL,
    comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,             -- 'mention' | 'reply' | 'status_change'
    is_read    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (username, is_read);
