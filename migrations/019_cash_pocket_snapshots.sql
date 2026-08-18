CREATE TABLE IF NOT EXISTS cash_pocket_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  pocket_id uuid NOT NULL REFERENCES cash_pockets(id) ON DELETE CASCADE,
  user_phone text,
  reference_date date,
  total_sold numeric(14,2),
  cash_balance numeric(14,2),
  receivable_total numeric(14,2),
  withdrawals_total numeric(14,2) NOT NULL DEFAULT 0,
  withdrawals_count integer NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_message_id text,
  source_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cash_pocket_snapshots_latest
  ON cash_pocket_snapshots(company_id, pocket_id, reference_date DESC, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_pocket_snapshots_source_message
  ON cash_pocket_snapshots(company_id, source_message_id)
  WHERE source_message_id IS NOT NULL;

UPDATE vertical_definitions
SET version = '2.5.0',
    updated_at = now()
WHERE id = 'cash';
