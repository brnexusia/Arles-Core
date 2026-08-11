ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS store_info_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS onboarding_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS logo_url text,
  ADD COLUMN IF NOT EXISTS legacy_supabase_migrated boolean NOT NULL DEFAULT false;

ALTER TABLE delivery_store_info
  ADD COLUMN IF NOT EXISTS ai_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS last_rating integer,
  ADD COLUMN IF NOT EXISTS last_review_at timestamptz;

ALTER TABLE menu_assets
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'menu_page',
  ADD COLUMN IF NOT EXISTS category text;

CREATE TABLE IF NOT EXISTS whatsapp_connections (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  instance_name text NOT NULL UNIQUE,
  instance_id text,
  phone_number text,
  status text NOT NULL DEFAULT 'disconnected',
  connected_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_status
  ON whatsapp_connections(status);

CREATE INDEX IF NOT EXISTS idx_delivery_products_company_category_name
  ON delivery_products(company_id, category, name);
