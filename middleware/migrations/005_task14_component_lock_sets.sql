ALTER TABLE component_locks
  DROP CONSTRAINT IF EXISTS component_locks_pkey;

ALTER TABLE component_locks
  ADD CONSTRAINT component_locks_pkey PRIMARY KEY (lock_id, component_key);
