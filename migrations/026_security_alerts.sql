CREATE TABLE IF NOT EXISTS security_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  kind text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  fingerprint text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_alerts_open_created
  ON security_alerts(created_at DESC)
  WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_security_alerts_company_created
  ON security_alerts(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_alerts_fingerprint_created
  ON security_alerts(fingerprint, created_at DESC)
  WHERE fingerprint IS NOT NULL;
