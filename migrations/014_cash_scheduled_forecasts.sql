CREATE TABLE IF NOT EXISTS cash_scheduled_forecasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_phone text,
  type text NOT NULL CHECK (type IN ('income', 'expense')),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  category text NOT NULL DEFAULT 'Outros',
  description text,
  pocket_id uuid REFERENCES cash_pockets(id) ON DELETE SET NULL,
  recurrence text NOT NULL CHECK (recurrence IN ('once', 'daily', 'weekly', 'monthly', 'yearly')),
  interval_count integer NOT NULL DEFAULT 1 CHECK (interval_count >= 1 AND interval_count <= 365),
  day_of_week smallint CHECK (day_of_week BETWEEN 0 AND 6),
  day_of_month smallint CHECK (day_of_month BETWEEN 1 AND 31),
  month_of_year smallint CHECK (month_of_year BETWEEN 1 AND 12),
  start_date date NOT NULL,
  end_date date,
  active boolean NOT NULL DEFAULT true,
  source_message_id text,
  source_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cash_scheduled_forecasts_company_active
  ON cash_scheduled_forecasts(company_id, active, start_date);

CREATE INDEX IF NOT EXISTS idx_cash_scheduled_forecasts_company_pocket
  ON cash_scheduled_forecasts(company_id, pocket_id, active);
