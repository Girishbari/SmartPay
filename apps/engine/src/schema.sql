CREATE TABLE IF NOT EXISTS tenants (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE IF NOT EXISTS client_apps (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), name text NOT NULL);
CREATE TABLE IF NOT EXISTS agents (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), name text NOT NULL, last_seen_at timestamptz);
CREATE TABLE IF NOT EXISTS target_apps (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE IF NOT EXISTS workflows (
  id text PRIMARY KEY,
  target_app_id text NOT NULL REFERENCES target_apps(id),
  name text NOT NULL,
  UNIQUE (target_app_id, name)
);
CREATE TABLE IF NOT EXISTS demonstrations (
  id text PRIMARY KEY,
  target_app_id text NOT NULL REFERENCES target_apps(id),
  recording text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS target_instances (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  target_app_id text NOT NULL REFERENCES target_apps(id),
  concurrency_limit int NOT NULL CHECK (concurrency_limit > 0),
  agent_id text REFERENCES agents(id)
);
CREATE TABLE IF NOT EXISTS workflow_versions (
  id text PRIMARY KEY,
  workflow_id text NOT NULL REFERENCES workflows(id),
  version int NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','published')),
  steps jsonb NOT NULL,
  target_map jsonb NOT NULL,
  parameters jsonb NOT NULL,
  outputs jsonb NOT NULL,
  commit_step int,
  demonstration_id text REFERENCES demonstrations(id),
  UNIQUE (workflow_id, version)
);
CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  client_app_id text,
  target_instance_id text NOT NULL REFERENCES target_instances(id),
  workflow_version_id text NOT NULL REFERENCES workflow_versions(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  parameters jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','needs_review')),
  attempt int NOT NULL DEFAULT 0,
  agent_id text,
  lease_expires_at timestamptz,
  commit_started_at timestamptz,
  outputs jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS runs_waiting ON runs (target_instance_id, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS runs_leased ON runs (lease_expires_at) WHERE status = 'running';
CREATE TABLE IF NOT EXISTS run_steps (
  run_id text NOT NULL REFERENCES runs(id),
  attempt int NOT NULL,
  step_no int NOT NULL,
  value_used text,
  outcome text NOT NULL,
  screenshot_key text,
  duration_ms int NOT NULL,
  PRIMARY KEY (run_id, attempt, step_no)
);
-- ponytail: additive columns for databases created before they existed; replace with a migration tool when needed.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE target_instances ADD COLUMN IF NOT EXISTS base_url text;
ALTER TABLE demonstrations ADD COLUMN IF NOT EXISTS workflow_name text;
ALTER TABLE workflow_versions ADD COLUMN IF NOT EXISTS examples jsonb;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS finished_at timestamptz;
