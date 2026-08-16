ALTER TABLE cash_settings
  ADD COLUMN IF NOT EXISTS owner_email text;

-- Onboarding WhatsApp-first: telefone (automatico) -> nome -> e-mail -> ativo.
ALTER TABLE cash_settings
  DROP CONSTRAINT IF EXISTS cash_settings_onboarding_state_check;

ALTER TABLE cash_settings
  ADD CONSTRAINT cash_settings_onboarding_state_check
  CHECK (onboarding_state IN ('welcome', 'awaiting_name', 'awaiting_email', 'active'));

-- Usuarios Cash que ja existiam antes desta migration passam uma unica vez pela
-- coleta de e-mail. O historico, trial e demais dados permanecem intactos.
UPDATE cash_settings
SET onboarding_state = CASE
      WHEN owner_name IS NULL OR btrim(owner_name) = '' THEN 'awaiting_name'
      ELSE 'awaiting_email'
    END,
    onboarding_completed_at = NULL,
    updated_at = now()
WHERE onboarding_state = 'active'
  AND (owner_email IS NULL OR btrim(owner_email) = '');

-- O e-mail ajuda na conciliacao de pagamento quando o sck nao estiver disponivel.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_settings_owner_email_unique
  ON cash_settings(lower(owner_email))
  WHERE owner_email IS NOT NULL AND btrim(owner_email) <> '';

ALTER TABLE cash_payment_events
  ADD COLUMN IF NOT EXISTS owner_email text,
  ADD COLUMN IF NOT EXISTS provider_event_type text,
  ADD COLUMN IF NOT EXISTS provider_order_id text,
  ADD COLUMN IF NOT EXISTS provider_offer_id text,
  ADD COLUMN IF NOT EXISTS provider_subscription_id text;

CREATE INDEX IF NOT EXISTS idx_cash_payment_events_provider_order
  ON cash_payment_events(provider, provider_order_id, created_at DESC)
  WHERE provider_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cash_payment_events_provider_subscription
  ON cash_payment_events(provider, provider_subscription_id, created_at DESC)
  WHERE provider_subscription_id IS NOT NULL;

-- Planos comerciais atuais do Arles Cash na Cakto.
INSERT INTO billing_plan_catalog(
  plan_key, display_name, display_price_cents, contact_limit, sort_order, configuration
) VALUES
  ('cash_monthly', 'Mensal', 500, 1000000, 10, '{"billing_cycle":"monthly","months":1}'::jsonb),
  ('cash_quarterly', 'Trimestral', 1350, 1000000, 20, '{"billing_cycle":"one_time","months":3}'::jsonb),
  ('cash_annual', 'Anual', 3990, 1000000, 30, '{"billing_cycle":"one_time","months":12,"popular":true}'::jsonb)
ON CONFLICT (plan_key) DO UPDATE SET
  display_name = excluded.display_name,
  display_price_cents = excluded.display_price_cents,
  contact_limit = excluded.contact_limit,
  sort_order = excluded.sort_order,
  configuration = excluded.configuration,
  active = true,
  updated_at = now();

-- O plano semestral existia na primeira versao, mas nao faz mais parte da oferta.
UPDATE billing_plan_catalog
SET active=false, updated_at=now()
WHERE plan_key='cash_semiannual';