ALTER TABLE cash_settings
  ADD COLUMN IF NOT EXISTS owner_name text,
  ADD COLUMN IF NOT EXISTS onboarding_state text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cash_settings_onboarding_state_check'
  ) THEN
    ALTER TABLE cash_settings
      ADD CONSTRAINT cash_settings_onboarding_state_check
      CHECK (onboarding_state IN ('awaiting_name', 'active'));
  END IF;
END $$;

UPDATE cash_settings cs
SET owner_name = nullif(trim(u.name), ''),
    onboarding_state = 'active',
    onboarding_completed_at = coalesce(cs.onboarding_completed_at, now())
FROM LATERAL (
  SELECT name
  FROM auth_users
  WHERE company_id = cs.company_id AND role = 'user'
  ORDER BY created_at ASC
  LIMIT 1
) u
WHERE cs.owner_name IS NULL;

CREATE TABLE IF NOT EXISTS cash_payment_events (
  id text PRIMARY KEY,
  provider text NOT NULL,
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  owner_phone text,
  plan_key text,
  status text NOT NULL,
  amount_cents integer,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cash_payment_events_company_created
  ON cash_payment_events(company_id, created_at DESC);

INSERT INTO billing_plan_catalog(
  plan_key, display_name, display_price_cents, contact_limit, sort_order, configuration
) VALUES
  ('cash_monthly', 'Mensal', 499, 1000000, 10, '{"billing_cycle":"monthly","months":1}'::jsonb),
  ('cash_semiannual', 'Semestral', 2490, 1000000, 20, '{"billing_cycle":"one_time","months":6}'::jsonb),
  ('cash_annual', 'Anual', 3990, 1000000, 30, '{"billing_cycle":"one_time","months":12,"popular":true}'::jsonb)
ON CONFLICT (plan_key) DO UPDATE SET
  display_name = excluded.display_name,
  display_price_cents = excluded.display_price_cents,
  contact_limit = excluded.contact_limit,
  sort_order = excluded.sort_order,
  configuration = excluded.configuration,
  active = true,
  updated_at = now();
