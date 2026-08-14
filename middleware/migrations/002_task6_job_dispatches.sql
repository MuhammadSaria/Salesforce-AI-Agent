ALTER TABLE development_jobs
  ADD COLUMN IF NOT EXISTS record jsonb,
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS job_dispatches (
  dispatch_key text PRIMARY KEY,
  job_id text NOT NULL REFERENCES development_jobs(job_id) ON DELETE RESTRICT,
  action text NOT NULL,
  actor_id text NOT NULL,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text NOT NULL DEFAULT '',
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  claimant_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz
);

ALTER TABLE job_dispatches
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS claimant_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;

CREATE INDEX IF NOT EXISTS job_dispatches_claimable_idx
  ON job_dispatches(status, lease_expires_at, created_at);

CREATE INDEX IF NOT EXISTS job_dispatches_job_id_created_at_idx
  ON job_dispatches(job_id, created_at);
