ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS instagram text;

CREATE TABLE IF NOT EXISTS company_settings (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS media_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id uuid REFERENCES delivery_orders(id) ON DELETE CASCADE,
  kind text NOT NULL,
  mime_type text NOT NULL,
  data bytea NOT NULL,
  size_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_media_files_company_created
  ON media_files(company_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_reviews_order_unique
  ON delivery_reviews(order_id)
  WHERE order_id IS NOT NULL;

ALTER TABLE delivery_orders
  ADD COLUMN IF NOT EXISTS status_updated_at timestamptz;
