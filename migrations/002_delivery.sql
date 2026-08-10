CREATE TABLE IF NOT EXISTS delivery_store_info (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  store_name text NOT NULL,
  short_description text,
  avg_time text,
  min_order numeric(12,2),
  opening_hours text,
  delivery_fee text,
  neighborhoods text,
  payment_methods text,
  pix_key text,
  ai_rules text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS delivery_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category text,
  name text NOT NULL,
  description text,
  price numeric(12,2) NOT NULL CHECK (price >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_products_company_active
  ON delivery_products(company_id, is_active);

CREATE TABLE IF NOT EXISTS product_variations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES delivery_products(id) ON DELETE CASCADE,
  name text NOT NULL,
  price_delta numeric(12,2) NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS menu_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  page_number integer NOT NULL DEFAULT 1,
  asset_url text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS delivery_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  client_name text NOT NULL,
  client_phone text NOT NULL,
  items jsonb NOT NULL,
  observations text,
  delivery_type text NOT NULL CHECK (delivery_type IN ('delivery','pickup')),
  delivery_address text,
  total_value numeric(12,2) NOT NULL CHECK (total_value >= 0),
  status text NOT NULL DEFAULT 'Novos',
  payment_method text NOT NULL CHECK (payment_method IN ('pix','cash','card')),
  payment_status text NOT NULL DEFAULT 'pending',
  change_for numeric(12,2),
  payment_proof_url text,
  payment_approved_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_orders_company_created
  ON delivery_orders(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_orders_company_phone_created
  ON delivery_orders(company_id, client_phone, created_at DESC);

CREATE TABLE IF NOT EXISTS delivery_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id uuid REFERENCES delivery_orders(id) ON DELETE SET NULL,
  customer_name text,
  phone_number text NOT NULL,
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);
