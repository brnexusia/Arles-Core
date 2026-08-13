CREATE TABLE IF NOT EXISTS vertical_definitions (
  id text PRIMARY KEY,
  name text NOT NULL,
  version text NOT NULL DEFAULT '1.0.0',
  capabilities text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO vertical_definitions(id, name, version, capabilities)
VALUES (
  'delivery',
  'Arles Delivery',
  '2.0.0',
  ARRAY[
    'delivery.orders',
    'delivery.catalog',
    'delivery.customers',
    'delivery.store',
    'delivery.payments',
    'delivery.reviews'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE SET
  name = excluded.name,
  version = excluded.version,
  capabilities = excluded.capabilities,
  enabled = true,
  updated_at = now();

CREATE TABLE IF NOT EXISTS company_verticals (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vertical_id text NOT NULL REFERENCES vertical_definitions(id),
  enabled boolean NOT NULL DEFAULT true,
  onboarding_completed boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id, vertical_id)
);

INSERT INTO company_verticals(company_id, vertical_id, enabled, onboarding_completed)
SELECT id, vertical, true, coalesce(onboarding_completed, false)
FROM companies
WHERE vertical = 'delivery'
ON CONFLICT (company_id, vertical_id) DO NOTHING;

ALTER TABLE companies ALTER COLUMN vertical DROP DEFAULT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS active_vertical_id text;
UPDATE companies SET active_vertical_id = vertical WHERE active_vertical_id IS NULL;
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_active_vertical_id_fkey;
ALTER TABLE companies
  ADD CONSTRAINT companies_active_vertical_id_fkey
  FOREIGN KEY(active_vertical_id) REFERENCES vertical_definitions(id);

ALTER TABLE conversation_sessions DROP CONSTRAINT IF EXISTS conversation_sessions_pkey;
ALTER TABLE conversation_sessions
  ADD CONSTRAINT conversation_sessions_pkey
  PRIMARY KEY(company_id, phone_number, vertical);

CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Contato',
  phone_number text NOT NULL,
  notes text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, phone_number)
);

CREATE TABLE IF NOT EXISTS delivery_customer_profiles (
  contact_id uuid PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  default_address text,
  favorite_payment text,
  total_orders integer NOT NULL DEFAULT 0,
  total_spent numeric(12,2) NOT NULL DEFAULT 0,
  last_rating integer,
  last_review_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO contacts(
  id, company_id, name, phone_number, notes,
  first_seen_at, last_seen_at, created_at, updated_at
)
SELECT
  id, company_id, name, phone_number, notes,
  first_seen_at, last_seen_at, created_at, updated_at
FROM customers
ON CONFLICT (id) DO UPDATE SET
  name = excluded.name,
  notes = excluded.notes,
  last_seen_at = excluded.last_seen_at,
  updated_at = excluded.updated_at;

INSERT INTO delivery_customer_profiles(
  contact_id, company_id, default_address, favorite_payment,
  total_orders, total_spent, last_rating, last_review_at, updated_at
)
SELECT
  id, company_id, default_address, favorite_payment,
  total_orders, total_spent, last_rating, last_review_at, updated_at
FROM customers
ON CONFLICT (contact_id) DO UPDATE SET
  default_address = excluded.default_address,
  favorite_payment = excluded.favorite_payment,
  total_orders = excluded.total_orders,
  total_spent = excluded.total_spent,
  last_rating = excluded.last_rating,
  last_review_at = excluded.last_review_at,
  updated_at = excluded.updated_at;

CREATE OR REPLACE FUNCTION sync_legacy_customer_to_contact()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO contacts(
    id, company_id, name, phone_number, notes,
    first_seen_at, last_seen_at, created_at, updated_at
  ) VALUES (
    NEW.id, NEW.company_id, NEW.name, NEW.phone_number, NEW.notes,
    NEW.first_seen_at, NEW.last_seen_at, NEW.created_at, NEW.updated_at
  )
  ON CONFLICT (id) DO UPDATE SET
    name = excluded.name,
    phone_number = excluded.phone_number,
    notes = excluded.notes,
    last_seen_at = excluded.last_seen_at,
    updated_at = excluded.updated_at;

  INSERT INTO delivery_customer_profiles(
    contact_id, company_id, default_address, favorite_payment,
    total_orders, total_spent, last_rating, last_review_at, updated_at
  ) VALUES (
    NEW.id, NEW.company_id, NEW.default_address, NEW.favorite_payment,
    NEW.total_orders, NEW.total_spent, NEW.last_rating, NEW.last_review_at, NEW.updated_at
  )
  ON CONFLICT (contact_id) DO UPDATE SET
    default_address = excluded.default_address,
    favorite_payment = excluded.favorite_payment,
    total_orders = excluded.total_orders,
    total_spent = excluded.total_spent,
    last_rating = excluded.last_rating,
    last_review_at = excluded.last_review_at,
    updated_at = excluded.updated_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_legacy_customer_to_contact ON customers;
CREATE TRIGGER trg_sync_legacy_customer_to_contact
AFTER INSERT OR UPDATE ON customers
FOR EACH ROW EXECUTE FUNCTION sync_legacy_customer_to_contact();

ALTER TABLE delivery_orders DROP CONSTRAINT IF EXISTS delivery_orders_customer_id_fkey;
ALTER TABLE delivery_orders
  ADD CONSTRAINT delivery_orders_customer_id_fkey
  FOREIGN KEY(customer_id) REFERENCES contacts(id) ON DELETE SET NULL;

ALTER TABLE media_files
  ADD COLUMN IF NOT EXISTS owner_vertical text,
  ADD COLUMN IF NOT EXISTS owner_type text,
  ADD COLUMN IF NOT EXISTS owner_id uuid;

UPDATE media_files
SET owner_vertical = 'delivery', owner_type = 'order', owner_id = order_id
WHERE order_id IS NOT NULL AND owner_id IS NULL;

ALTER TABLE media_files DROP CONSTRAINT IF EXISTS media_files_order_id_fkey;

DO $$
BEGIN
  IF to_regclass('delivery_product_variations') IS NULL
     AND to_regclass('product_variations') IS NOT NULL THEN
    ALTER TABLE product_variations RENAME TO delivery_product_variations;
  END IF;
  IF to_regclass('delivery_menu_assets') IS NULL
     AND to_regclass('menu_assets') IS NOT NULL THEN
    ALTER TABLE menu_assets RENAME TO delivery_menu_assets;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_company_verticals_enabled
  ON company_verticals(company_id, enabled);
CREATE INDEX IF NOT EXISTS idx_companies_active_vertical
  ON companies(active_vertical_id);
CREATE INDEX IF NOT EXISTS idx_contacts_company_last_seen
  ON contacts(company_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_owner
  ON media_files(company_id, owner_vertical, owner_type, owner_id);
