-- Security hardening: explicit RBAC for administrative users.
ALTER TABLE auth_users
  ADD COLUMN IF NOT EXISTS permissions text[] NOT NULL DEFAULT ARRAY[]::text[];

-- Preserve current administrators while moving from role-only authorization.
UPDATE auth_users
SET permissions = ARRAY['admin.*']::text[]
WHERE role = 'admin'
  AND cardinality(permissions) = 0;

CREATE INDEX IF NOT EXISTS idx_auth_users_role_permissions
  ON auth_users(role)
  WHERE role = 'admin';
