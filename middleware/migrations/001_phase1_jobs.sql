CREATE TABLE IF NOT EXISTS development_jobs (
  job_id text PRIMARY KEY,
  user_id text NOT NULL,
  org_id text NOT NULL,
  prompt text NOT NULL,
  status text NOT NULL,
  current_plan_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_messages (
  message_id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES development_jobs(job_id) ON DELETE RESTRICT,
  role text NOT NULL,
  kind text NOT NULL,
  text text NOT NULL,
  body jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_plans (
  plan_id bigserial PRIMARY KEY,
  job_id text NOT NULL REFERENCES development_jobs(job_id) ON DELETE RESTRICT,
  version integer NOT NULL,
  plan_hash text NOT NULL,
  scope_hash text NOT NULL,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, version)
);

CREATE TABLE IF NOT EXISTS job_approvals (
  approval_id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES development_jobs(job_id) ON DELETE RESTRICT,
  approval_type text NOT NULL,
  decision text NOT NULL,
  actor_id text NOT NULL,
  plan_hash text NOT NULL,
  scope_hash text NOT NULL,
  body jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_events (
  event_id bigserial PRIMARY KEY,
  job_id text NOT NULL REFERENCES development_jobs(job_id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  actor_id text NOT NULL DEFAULT 'system',
  body jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS component_locks (
  lock_id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES development_jobs(job_id) ON DELETE RESTRICT,
  component_key text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_messages_job_id_created_at_idx ON job_messages(job_id, created_at);
CREATE INDEX IF NOT EXISTS job_plans_job_id_version_idx ON job_plans(job_id, version);
CREATE INDEX IF NOT EXISTS job_approvals_job_id_created_at_idx ON job_approvals(job_id, created_at);
CREATE INDEX IF NOT EXISTS job_events_job_id_created_at_idx ON job_events(job_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS component_locks_active_component_key_idx
  ON component_locks(component_key)
  WHERE released_at IS NULL;
