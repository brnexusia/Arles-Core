-- Estruturas aditivas da Arles Platform. As projeções/colunas legadas são
-- preservadas para rollback e compatibilidade durante a transição.

CREATE TABLE IF NOT EXISTS company_capabilities (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  capability_key text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'suspended')),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, capability_key)
);

CREATE INDEX IF NOT EXISTS idx_company_capabilities_key_status
  ON company_capabilities(capability_key, status);

-- companies.vertical continua como projeção compatível.
INSERT INTO company_capabilities(company_id, capability_key, status)
SELECT id, 'vertical.' || lower(vertical), 'active'
FROM companies
WHERE coalesce(vertical, '') <> ''
ON CONFLICT (company_id, capability_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS media_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  owner_type text NOT NULL,
  owner_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(media_id, owner_type, owner_id)
);

CREATE INDEX IF NOT EXISTS idx_media_links_owner
  ON media_links(company_id, owner_type, owner_id);

INSERT INTO media_links(company_id, media_id, owner_type, owner_id)
SELECT company_id, id, 'delivery.order', order_id
FROM media_files
WHERE order_id IS NOT NULL
ON CONFLICT (media_id, owner_type, owner_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS onboarding_progress (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  step_key text NOT NULL,
  capability_key text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'skipped')),
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id, step_key)
);

CREATE TABLE IF NOT EXISTS billing_plan_catalog (
  plan_key text PRIMARY KEY,
  display_name text NOT NULL,
  display_price_cents integer NOT NULL CHECK (display_price_cents >= 0),
  currency text NOT NULL DEFAULT 'BRL',
  contact_limit integer NOT NULL CHECK (contact_limit > 0),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Valores comerciais existentes; esta migration não altera preços ou planos.
INSERT INTO billing_plan_catalog(
  plan_key, display_name, display_price_cents, contact_limit, sort_order
) VALUES
  ('essential', 'Essencial', 4990, 360, 10),
  ('professional', 'Profissional', 19700, 1500, 20),
  ('scale', 'Escala', 29700, 3000, 30)
ON CONFLICT (plan_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS billing_usage_periods (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  metric_key text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  consumed bigint NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  limit_value bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id, metric_key, period_start)
);

CREATE TABLE IF NOT EXISTS platform_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  module_key text NOT NULL,
  job_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'retry', 'dead')),
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  idempotency_key text NOT NULL,
  locked_at timestamptz,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, module_key, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_platform_jobs_due
  ON platform_jobs(status, run_at)
  WHERE status IN ('pending', 'retry');

CREATE TABLE IF NOT EXISTS platform_job_attempts (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES platform_jobs(id) ON DELETE CASCADE,
  attempt integer NOT NULL,
  status text NOT NULL,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
