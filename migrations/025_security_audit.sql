CREATE TABLE IF NOT EXISTS security_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  request_id text,
  source text NOT NULL DEFAULT 'core',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_audit_company_created
  ON security_audit_events(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_audit_actor_created
  ON security_audit_events(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_audit_action_created
  ON security_audit_events(action, created_at DESC);

-- Audit events are intentionally insert-only at the application layer.
COMMENT ON TABLE security_audit_events IS 'Security-sensitive audit trail. Application code must never update/delete rows.';
