ALTER TABLE cash_settings
  ADD COLUMN IF NOT EXISTS owner_email text;

-- Onboarding WhatsApp-first: telefone (automatico) -> nome -> e-mail -> ativo.
ALTER TABLE cash_settings
  DROP CONSTRAINT IF EXISTS cash_settings_onboarding_state_check;

ALTER TABLE cash_settings
  ADD CONSTRAINT cash_settings_onboarding_state_check
  CHECK (onboarding_state IN ('welcome', 'awaiting_name', 'awaiting_email', 'active'));

-- O e-mail ajuda na conciliacao de pagamento quando o provedor nao devolver o sck.
-- Um mesmo e-mail nao pode representar duas contas Cash distintas.
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
