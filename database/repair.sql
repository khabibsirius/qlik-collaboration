-- =============================================================================
--  Qlik Collaboration — data repair
--
--  schema.sql fixes the SHAPE of the database. This fixes the DATA that stops the
--  shape from being applied — specifically, users whose names differ only in
--  capitalisation. While such a pair exists the unique index on lower(username)
--  cannot be built, and that person's role is whichever row is found first.
--
--  Run it after schema.sql:
--      psql -U postgres -d qlik_collaboration -f database/schema.sql
--      psql -U postgres -d qlik_collaboration -f database/repair.sql
--
--  It runs in one transaction and prints every change. Nothing is deleted without
--  its comments and notifications being moved to the row that is kept.
--
--  Which row is kept: the one that has written the most comments; if that ties, the
--  one that existed first. That keeps the spelling the team has actually been using
--  rather than whichever sorts first.
-- =============================================================================

BEGIN;

DO $$
DECLARE
    pair        RECORD;
    keeper      TEXT;
    loser       TEXT;
    moved       INTEGER;
    merges      INTEGER := 0;
BEGIN
    FOR pair IN
        SELECT lower(username) AS key, count(*) AS n
        FROM users
        GROUP BY lower(username)
        HAVING count(*) > 1
    LOOP
        -- the spelling that has written the most, oldest wins a tie
        SELECT u.username INTO keeper
        FROM users u
        LEFT JOIN comments c ON c.author = u.username AND c.is_deleted = FALSE
        WHERE lower(u.username) = pair.key
        GROUP BY u.id, u.username
        ORDER BY count(c.id) DESC, u.id ASC
        LIMIT 1;

        RAISE NOTICE 'Merging % rows for "%" into "%"', pair.n, pair.key, keeper;

        FOR loser IN
            SELECT username FROM users
            WHERE lower(username) = pair.key AND username <> keeper
        LOOP
            UPDATE comments SET author = keeper WHERE author = loser;
            GET DIAGNOSTICS moved = ROW_COUNT;
            IF moved > 0 THEN
                RAISE NOTICE '  moved % comment(s) from "%" to "%"', moved, loser, keeper;
            END IF;

            UPDATE notifications SET username = keeper WHERE username = loser;
            GET DIAGNOSTICS moved = ROW_COUNT;
            IF moved > 0 THEN
                RAISE NOTICE '  moved % notification(s) from "%" to "%"', moved, loser, keeper;
            END IF;

            -- keep the stronger role: merging must never quietly demote someone
            UPDATE users k
            SET role = CASE
                    WHEN k.role = 'admin' OR l.role = 'admin' THEN 'admin'
                    WHEN k.role = 'team'  OR l.role = 'team'  THEN 'team'
                    ELSE 'guest'
                END,
                user_directory = COALESCE(k.user_directory, l.user_directory)
            FROM users l
            WHERE k.username = keeper AND l.username = loser;

            DELETE FROM users WHERE username = loser;
            RAISE NOTICE '  removed duplicate row "%"', loser;
        END LOOP;

        merges := merges + 1;
    END LOOP;

    IF merges = 0 THEN
        RAISE NOTICE 'No duplicate usernames — nothing to merge.';
    ELSE
        RAISE NOTICE '% name(s) merged.', merges;
    END IF;
END $$;

-- Now that every person is one row, the index can exist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (lower(username));

-- Comments written by someone who never registered — possible on older databases,
-- where a name was typed before the panel announced users. They are what makes the
-- inbox's people filter miss someone.
INSERT INTO users (username, display_name, role)
SELECT DISTINCT c.author, c.author, 'guest'
FROM comments c
WHERE c.is_deleted = FALSE
  AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.username) = lower(c.author));

COMMIT;

-- What the database looks like afterwards.
SELECT 'users'         AS what, count(*)::TEXT AS value FROM users
UNION ALL SELECT 'duplicate names', count(*)::TEXT FROM (
    SELECT 1 FROM users GROUP BY lower(username) HAVING count(*) > 1) d
UNION ALL SELECT 'unique index', CASE WHEN EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_users_username_lower')
    THEN 'present' ELSE 'MISSING' END
UNION ALL SELECT 'comments', count(*)::TEXT FROM comments WHERE is_deleted = FALSE;
