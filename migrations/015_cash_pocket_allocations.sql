ALTER TABLE cash_pockets
  ADD COLUMN IF NOT EXISTS allocation_balance numeric(14,2) NOT NULL DEFAULT 0;

UPDATE vertical_definitions
SET version = '2.3.0',
    updated_at = now()
WHERE id = 'cash';
