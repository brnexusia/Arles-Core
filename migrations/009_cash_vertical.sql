INSERT INTO vertical_definitions(id, name, version, capabilities)
VALUES (
  'cash',
  'Arles Cash',
  '1.0.0',
  ARRAY[
    'cash.transactions',
    'cash.summaries',
    'cash.settings'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE SET
  name = excluded.name,
  version = excluded.version,
  capabilities = excluded.capabilities,
  enabled = true,
  updated_at = now();

CREATE TABLE IF NOT EXISTS cash_settings (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  owner_phone text,
  weekly_report_enabled boolean NOT NULL DEFAULT true,
  monthly_report_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cash_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_phone text,
  type text NOT NULL CHECK (type IN ('income', 'expense')),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  category text NOT NULL DEFAULT 'Outros',
  merchant text,
  description text,
  transaction_date date NOT NULL DEFAULT current_date,
  source_message_id text,
  source_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, source_message_id)
);

CREATE INDEX IF NOT EXISTS idx_cash_transactions_company_date
  ON cash_transactions(company_id, transaction_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cash_transactions_company_type
  ON cash_transactions(company_id, type, transaction_date DESC);

