ALTER TABLE cash_settings
  ADD COLUMN IF NOT EXISTS owner_email text;

-- O onboarding novo passa por nome -> e-mail -> ativo.
ALTER TABLE cash_settings
  DROP CONSTRAINT IF EXISTS cash_settings_onboarding_state_check;

ALTER TABLE cash_settings
  ADD CONSTRAINT cash_settings_onboarding_state_check
  CHECK (onboarding_state IN ('welcome', 'awaiting_name', 'awaiting_email', 'active'));

-- E-mail funciona como dado de conciliação de pagamento. Mantemos um e-mail por conta Cash
-- para evitar ambiguidade quando o provedor não devolver company_id/telefone de forma confiável.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_settings_owner_email_unique
  ON cash_settings(lower(owner_email))
  WHERE owner_email IS NOT NULL AND btrim(owner_email) <> '';

ALTER TABLE cash_payment_events
  ADD COLUMN IF NOT EXISTS owner_email text;

CREATE TABLE IF NOT EXISTS cash_activation_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_event_id text NOT NULL UNIQUE REFERENCES cash_payment_events(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  owner_phone text NOT NULL,
  owner_email text,
  plan_key text NOT NULL,
  code_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cash_activation_codes_company_created
  ON cash_activation_codes(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cash_activation_codes_pending
  ON cash_activation_codes(company_id, expires_at)
  WHERE redeemed_at IS NULL;
