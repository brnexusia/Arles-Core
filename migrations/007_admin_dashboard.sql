ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS monthly_price_cents integer;

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_monthly_price_cents_check;
ALTER TABLE companies
  ADD CONSTRAINT companies_monthly_price_cents_check
  CHECK (monthly_price_cents IS NULL OR monthly_price_cents >= 0);

CREATE INDEX IF NOT EXISTS idx_companies_subscription_status
  ON companies(subscription_status);

CREATE TABLE IF NOT EXISTS billing_payments (
  stripe_invoice_id text PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  amount_paid_cents integer NOT NULL CHECK (amount_paid_cents >= 0),
  currency text NOT NULL DEFAULT 'brl',
  paid_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_payments_company_paid
  ON billing_payments(company_id, paid_at DESC);
