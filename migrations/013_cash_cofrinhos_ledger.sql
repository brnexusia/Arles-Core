CREATE TABLE IF NOT EXISTS cash_pockets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  normalized_name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_cash_pockets_company_active
  ON cash_pockets(company_id, active, created_at);

ALTER TABLE cash_transactions
  ADD COLUMN IF NOT EXISTS pocket_id uuid REFERENCES cash_pockets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cash_transactions_company_pocket_date
  ON cash_transactions(company_id, pocket_id, transaction_date DESC, created_at DESC);

UPDATE vertical_definitions
SET capabilities = CASE
      WHEN NOT ('cash.pockets' = ANY(capabilities)) THEN array_append(capabilities, 'cash.pockets')
      ELSE capabilities
    END,
    version = '2.1.0',
    updated_at = now()
WHERE id = 'cash';
