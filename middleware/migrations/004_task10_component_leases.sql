DROP INDEX IF EXISTS component_locks_active_component_key_idx;

DELETE FROM component_locks WHERE released_at IS NOT NULL;

DELETE FROM component_locks older
USING component_locks newer
WHERE older.component_key = newer.component_key
  AND (older.updated_at, older.lock_id) < (newer.updated_at, newer.lock_id);

CREATE UNIQUE INDEX IF NOT EXISTS component_locks_component_key_idx
  ON component_locks(component_key);
