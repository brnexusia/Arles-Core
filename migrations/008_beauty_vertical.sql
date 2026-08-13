INSERT INTO vertical_definitions(id, name, version, capabilities)
VALUES (
  'beauty',
  'Arles Beauty',
  '1.0.0',
  ARRAY[
    'beauty.appointments',
    'beauty.services',
    'beauty.professionals',
    'beauty.availability',
    'beauty.customers'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE SET
  name = excluded.name,
  version = excluded.version,
  capabilities = excluded.capabilities,
  enabled = true,
  updated_at = now();

CREATE TABLE IF NOT EXISTS beauty_settings (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  business_name text,
  address text,
  instagram text,
  cancellation_policy text,
  booking_notice_minutes integer NOT NULL DEFAULT 60,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS beauty_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 720),
  price numeric(12,2) NOT NULL CHECK (price >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_beauty_services_company_active
  ON beauty_services(company_id, active);

CREATE TABLE IF NOT EXISTS beauty_professionals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  specialty text,
  phone text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS beauty_professional_services (
  professional_id uuid NOT NULL REFERENCES beauty_professionals(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES beauty_services(id) ON DELETE CASCADE,
  PRIMARY KEY(professional_id, service_id)
);

CREATE TABLE IF NOT EXISTS beauty_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  professional_id uuid NOT NULL REFERENCES beauty_professionals(id) ON DELETE CASCADE,
  weekday integer NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time time NOT NULL,
  slot_interval_minutes integer NOT NULL DEFAULT 30 CHECK (slot_interval_minutes BETWEEN 5 AND 240),
  active boolean NOT NULL DEFAULT true,
  CHECK (end_time > start_time),
  UNIQUE(professional_id, weekday)
);

CREATE TABLE IF NOT EXISTS beauty_appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  service_id uuid NOT NULL REFERENCES beauty_services(id),
  professional_id uuid NOT NULL REFERENCES beauty_professionals(id),
  customer_name text NOT NULL,
  customer_phone text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','confirmed','completed','canceled','no_show')),
  notes text,
  source text NOT NULL DEFAULT 'panel',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_beauty_appointments_company_start
  ON beauty_appointments(company_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_beauty_appointments_professional_start
  ON beauty_appointments(professional_id, starts_at)
  WHERE status IN ('scheduled','confirmed');

