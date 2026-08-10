CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  vertical text NOT NULL DEFAULT 'delivery',
  evolution_instance text NOT NULL UNIQUE,
  subscription_status text NOT NULL DEFAULT 'trial',
  access_active boolean NOT NULL DEFAULT true,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Cliente',
  phone_number text NOT NULL,
  default_address text,
  favorite_payment text,
  total_orders integer NOT NULL DEFAULT 0,
  total_spent numeric(12,2) NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, phone_number)
);

CREATE TABLE IF NOT EXISTS conversation_sessions (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  phone_number text NOT NULL,
  vertical text NOT NULL,
  state text NOT NULL DEFAULT 'idle',
  draft jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id, phone_number)
);

CREATE TABLE IF NOT EXISTS messages (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  phone_number text NOT NULL,
  message_id text,
  direction text NOT NULL CHECK (direction IN ('in','out')),
  message_type text NOT NULL DEFAULT 'text',
  body text,
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_company_phone_created
  ON messages(company_id, phone_number, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_company_message_unique
  ON messages(company_id, message_id)
  WHERE message_id IS NOT NULL AND message_id <> '';
