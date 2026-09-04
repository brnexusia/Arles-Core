CREATE TABLE IF NOT EXISTS auth_password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_password_reset_user_created
  ON auth_password_reset_tokens(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_password_reset_expires
  ON auth_password_reset_tokens(expires_at)
  WHERE used_at IS NULL;
