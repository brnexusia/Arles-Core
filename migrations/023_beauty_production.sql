-- Arles Beauty production hardening.
-- Additive only: existing Delivery/Cash/legacy integrations remain untouched.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS evolution_cluster text,
  ADD COLUMN IF NOT EXISTS billing_provider text,
  ADD COLUMN IF NOT EXISTS asaas_customer_id text,
  ADD COLUMN IF NOT EXISTS asaas_pix_authorization_id text,
  ADD COLUMN IF NOT EXISTS asaas_subscription_id text,
  ADD COLUMN IF NOT EXISTS asaas_authorization_status text,
  ADD COLUMN IF NOT EXISTS monthly_price_cents integer,
  ADD COLUMN IF NOT EXISTS acquisition jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_companies_evolution_cluster
  ON companies(evolution_cluster)
  WHERE evolution_cluster IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_companies_asaas_customer
  ON companies(asaas_customer_id)
  WHERE asaas_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_companies_asaas_authorization
  ON companies(asaas_pix_authorization_id)
  WHERE asaas_pix_authorization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_companies_acquisition_gin
  ON companies USING gin(acquisition);

ALTER TABLE whatsapp_connections
  ADD COLUMN IF NOT EXISTS cluster_key text,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS reconnect_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_connected_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_disconnected_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_cluster_status
  ON whatsapp_connections(cluster_key, status);

CREATE TABLE IF NOT EXISTS asaas_events (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  resource_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_asaas_events_resource
  ON asaas_events(resource_id, received_at DESC);

CREATE TABLE IF NOT EXISTS beauty_billing_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  asaas_payment_id text NOT NULL,
  status text NOT NULL,
  value_cents integer NOT NULL CHECK (value_cents >= 0),
  due_date date,
  paid_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(asaas_payment_id)
);

CREATE INDEX IF NOT EXISTS idx_beauty_billing_payments_company_created
  ON beauty_billing_payments(company_id, created_at DESC);

-- Beauty uses the global contacts table introduced by the vertical engine.
CREATE INDEX IF NOT EXISTS idx_contacts_company_phone
  ON contacts(company_id, phone_number);

-- Keep instance names globally unique across Evolution clusters. This lets the
-- shared inbound webhook resolve a tenant safely without changing other verticals.
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_evolution_instance_unique
  ON companies(evolution_instance);

-- Explicit status for accounts that registered but have not activated billing yet.
UPDATE companies
SET billing_provider = 'asaas',
    monthly_price_cents = 4990,
    subscription_status = CASE WHEN subscription_status = 'trial' THEN 'pending' ELSE subscription_status END,
    access_active = CASE WHEN subscription_status = 'trial' THEN false ELSE access_active END
WHERE coalesce(active_vertical_id, vertical) = 'beauty';
