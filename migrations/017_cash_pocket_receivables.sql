CREATE TABLE IF NOT EXISTS cash_pocket_receivables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  pocket_id uuid NOT NULL REFERENCES cash_pockets(id) ON DELETE CASCADE,
  user_phone text,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  description text,
  debtor text,
  due_date date,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'received', 'cancelled')),
  received_transaction_id uuid REFERENCES cash_transactions(id) ON DELETE SET NULL,
  source_message_id text,
  source_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cash_pocket_receivables_company_status
  ON cash_pocket_receivables(company_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cash_pocket_receivables_pocket_status
  ON cash_pocket_receivables(company_id, pocket_id, status, created_at DESC);

UPDATE vertical_definitions
SET version = '2.4.0',
    updated_at = now()
WHERE id = 'cash';
