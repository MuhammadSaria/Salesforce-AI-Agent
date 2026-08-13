ALTER TABLE job_dispatches
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS terminal_at timestamptz,
  ADD COLUMN IF NOT EXISTS terminal_reason text NOT NULL DEFAULT '';

DROP INDEX IF EXISTS job_dispatches_claimable_idx;
CREATE INDEX IF NOT EXISTS job_dispatches_claimable_idx
  ON job_dispatches(status, next_attempt_at, lease_expires_at, created_at);
