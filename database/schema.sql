-- =============================================================================
--  Qlik Collaboration — PostgreSQL schema
--
--  One file. Run it on an empty database to create everything, or on a running
--  server to bring it up to date. It is idempotent: every statement checks before
--  it acts, so running it twice does nothing the second time, and running it on a
--  live database keeps every existing comment.
--
--      psql -U postgres -d qlik_collaboration -f database/schema.sql
--
--  The API can also apply it itself at startup — Database:ApplySchemaOnStart=true
--  (env: DB_APPLY_SCHEMA=true). It carries this exact file inside the build.
--
--  Layout:
--      1. Tables      the current shape, in full
--      2. Upgrade     the few statements that reconcile an older database to it
--      3. Indexes
--      4. Documentation
--
--  Conventions: snake_case; pk_ / fk_ / ck_ / uq_ on named constraints; idx_ on
--  indexes. Named constraints apply to databases created by this file; one created
--  by an earlier version keeps PostgreSQL's generated names, which is cosmetic.
-- =============================================================================


-- =============================================================================
--  1. TABLES
-- =============================================================================

-- People. Qlik Sense Desktop has no login and reports everyone as Personal\Me, so
-- a name is typed there. On Enterprise the Qlik Proxy supplies the AD identity and
-- username is that account name.
CREATE TABLE IF NOT EXISTS users (
    id              SERIAL,
    username        TEXT        NOT NULL,
    display_name    TEXT        NOT NULL,
    user_directory  TEXT        NULL,
    role            TEXT        NOT NULL DEFAULT 'guest',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT pk_users      PRIMARY KEY (id),
    CONSTRAINT uq_users_name UNIQUE (username),
    CONSTRAINT ck_users_role CHECK (role IN ('admin', 'team', 'guest'))
);

-- Comments. One table carries every binding level:
--   sheet-level      no rows in comment_objects
--   object-level     one row per chart in comment_objects
--   with selections  selection_state holds the filters that were in force
--   replies          parent_id -> comments.id, one level deep, like Teams
CREATE TABLE IF NOT EXISTS comments (
    id              SERIAL,
    app_id          TEXT        NOT NULL,
    sheet_id        TEXT        NOT NULL,
    app_name        TEXT        NULL,
    sheet_name      TEXT        NULL,
    parent_id       INTEGER     NULL,
    author          TEXT        NOT NULL,
    body            TEXT        NOT NULL,
    selection_state JSONB       NULL,
    status          TEXT        NOT NULL DEFAULT 'new',
    is_deleted      BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NULL,

    CONSTRAINT pk_comments        PRIMARY KEY (id),
    CONSTRAINT fk_comments_parent FOREIGN KEY (parent_id)
                                  REFERENCES comments (id) ON DELETE CASCADE,
    CONSTRAINT ck_comments_status CHECK (status IN ('new', 'in_progress', 'fixed', 'closed'))
);

-- Which charts on the sheet a comment is pinned to. No rows means the whole sheet.
CREATE TABLE IF NOT EXISTS comment_objects (
    comment_id  INTEGER NOT NULL,
    object_id   TEXT    NOT NULL,

    CONSTRAINT pk_comment_objects         PRIMARY KEY (comment_id, object_id),
    CONSTRAINT fk_comment_objects_comment FOREIGN KEY (comment_id)
                                          REFERENCES comments (id) ON DELETE CASCADE
);

-- Files and voice messages. The bytes live on disk; only metadata is here.
CREATE TABLE IF NOT EXISTS attachments (
    id            SERIAL,
    comment_id    INTEGER     NOT NULL,
    file_name     TEXT        NOT NULL,
    content_type  TEXT        NOT NULL,
    size_bytes    BIGINT      NOT NULL,
    storage_path  TEXT        NOT NULL,
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT pk_attachments         PRIMARY KEY (id),
    CONSTRAINT fk_attachments_comment FOREIGN KEY (comment_id)
                                      REFERENCES comments (id) ON DELETE CASCADE
);

-- One row per recipient per comment.
CREATE TABLE IF NOT EXISTS notifications (
    id          SERIAL,
    username    TEXT        NOT NULL,
    comment_id  INTEGER     NOT NULL,
    kind        TEXT        NOT NULL,
    is_read     BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT pk_notifications         PRIMARY KEY (id),
    CONSTRAINT fk_notifications_comment FOREIGN KEY (comment_id)
                                        REFERENCES comments (id) ON DELETE CASCADE
);

-- One row per digest e-mail actually sent.
CREATE TABLE IF NOT EXISTS digest_runs (
    id          SERIAL,
    sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    new_items   INTEGER     NOT NULL DEFAULT 0,
    waiting     INTEGER     NOT NULL DEFAULT 0,
    recipients  TEXT        NOT NULL DEFAULT '',

    CONSTRAINT pk_digest_runs PRIMARY KEY (id)
);


-- =============================================================================
--  2. UPGRADE
--
--  CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so a
--  database built by an earlier version needs the columns above added explicitly.
--  These are the only statements here that change an existing table, and they are
--  all no-ops once applied. New installs skip straight past them.
-- =============================================================================

ALTER TABLE comments ADD COLUMN IF NOT EXISTS app_name   TEXT NULL;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS sheet_name TEXT NULL;
ALTER TABLE users    ADD COLUMN IF NOT EXISTS role       TEXT NOT NULL DEFAULT 'guest';

-- ADD CONSTRAINT has no IF NOT EXISTS of its own.
DO $$
BEGIN
    ALTER TABLE users ADD CONSTRAINT ck_users_role
        CHECK (role IN ('admin', 'team', 'guest'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;


-- =============================================================================
--  3. INDEXES
-- =============================================================================

-- Names differing only in capitalisation are the same person: Qlik reports one
-- spelling and a configured admin entry may use another. Without this the same
-- person becomes two rows and their role is whichever is found first.
--
-- A database that already holds such a pair cannot have the index built. That does
-- not fail this script: nothing in the application depends on the index — user
-- registration updates-then-inserts rather than relying on ON CONFLICT — so the
-- server runs correctly without it. The API repeats the warning at every startup,
-- naming the pair, until they are merged and this file is run again.
DO $$
BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (lower(username));
EXCEPTION
    WHEN unique_violation THEN
        RAISE WARNING
            'users holds names differing only in capitalisation, so the unique index '
            'was skipped. Merge each pair — keep the spelling Qlik reports, move the '
            'other row''s comments onto it — then run this file again.';
END $$;

CREATE INDEX IF NOT EXISTS idx_users_role           ON users (role);
CREATE INDEX IF NOT EXISTS idx_comments_app_sheet   ON comments (app_id, sheet_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent      ON comments (parent_id);
CREATE INDEX IF NOT EXISTS idx_comment_objects_object ON comment_objects (object_id);
CREATE INDEX IF NOT EXISTS idx_attachments_comment  ON attachments (comment_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user   ON notifications (username, is_read);

-- The team inbox's main query: open threads across every app, newest first.
CREATE INDEX IF NOT EXISTS idx_comments_open
    ON comments (status, created_at DESC)
    WHERE parent_id IS NULL AND is_deleted = FALSE;


-- =============================================================================
--  4. DOCUMENTATION
--
--  Kept together so the definitions above stay readable. \d+ in psql shows these.
-- =============================================================================

COMMENT ON TABLE users IS
    'Everyone who has opened the panel. Comments notify the team, so a colleague who only reads still has to be here.';
COMMENT ON COLUMN users.user_directory IS
    'Qlik UserDirectory the identity came from: BANK on Enterprise/AD, Personal on Desktop, NULL for a typed name. Shows which comments came from a real authenticated identity.';
COMMENT ON COLUMN users.role IS
    'guest sees only the threads they started (the default, and the safe one — two executives must not read each other''s feedback); team sees every thread and receives notifications; admin is team plus deleting anyone''s comment and granting roles.';

COMMENT ON COLUMN comments.app_id IS
    'Qlik app id: a GUID on Enterprise, the .qvf path on Desktop.';
COMMENT ON COLUMN comments.app_name IS
    'Dashboard title as the extension read it. Nullable: rows written before titles were captured fall back to showing the id.';
COMMENT ON COLUMN comments.selection_state IS
    'The filters in force when the comment was written, replayed by "apply filters": [{"field":"Bank","values":["NBU"],"raw":[...]}]';
COMMENT ON COLUMN comments.is_deleted IS
    'Soft delete. A deleted parent keeps its replies readable rather than cascading them away.';

COMMENT ON TABLE comment_objects IS
    'Which charts on the sheet a comment is pinned to. No rows means the comment is about the sheet as a whole.';
COMMENT ON TABLE attachments IS
    'Files and voice messages. The bytes live on disk at storage_path; only the metadata is here.';
COMMENT ON TABLE notifications IS
    'One row per recipient per comment. A new comment produces one for the team and for the thread''s author.';
COMMENT ON COLUMN notifications.kind IS
    'comment | reply | status_change. Rows written before @mentions were removed may also hold mention or broadcast.';
COMMENT ON TABLE digest_runs IS
    'One row per digest e-mail actually sent. The next digest reports what happened since the last row, which stops it repeating the same unanswered comment every half hour.';
