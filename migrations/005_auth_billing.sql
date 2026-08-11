CREATE TABLE IF NOT EXISTS auth_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  email text NOT NULL,
  email_normalized text NOT NULL,
  password_hash text,
  name text NOT NULL DEFAULT '',
  phone text,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  legacy_supabase_user_id uuid,
  migrated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_email_normalized
  ON auth_users(email_normalized);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_company_user
  ON auth_users(company_id)
  WHERE company_id IS NOT NULL AND role = 'user';

CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_expires
  ON auth_sessions(user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS trial_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  email_normalized text,
  phone_normalized text,
  trial_started_at timestamptz NOT NULL DEFAULT now(),
  trial_ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_entitlements_email
  ON trial_entitlements(email_normalized)
  WHERE email_normalized IS NOT NULL AND email_normalized <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_entitlements_phone
  ON trial_entitlements(phone_normalized)
  WHERE phone_normalized IS NOT NULL AND phone_normalized <> '';

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS stripe_price_id text,
  ADD COLUMN IF NOT EXISTS subscription_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS subscription_current_period_end timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS plan_key text,
  ADD COLUMN IF NOT EXISTS monthly_contact_limit integer,
  ADD COLUMN IF NOT EXISTS monthly_contacts_used integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS monthly_contacts_reset_at date;

CREATE INDEX IF NOT EXISTS idx_companies_stripe_customer
  ON companies(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_companies_stripe_subscription
  ON companies(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS stripe_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
