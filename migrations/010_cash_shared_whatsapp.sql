-- Backfill do número autorizado para contas Cash já existentes.
INSERT INTO cash_settings(company_id, owner_phone)
SELECT
  c.id,
  regexp_replace(coalesce(u.phone,''), '[^0-9]', '', 'g')
FROM companies c
LEFT JOIN LATERAL (
  SELECT phone
  FROM auth_users
  WHERE company_id = c.id AND role = 'user'
  ORDER BY created_at ASC
  LIMIT 1
) u ON true
WHERE coalesce(c.active_vertical_id,c.vertical) = 'cash'
  AND regexp_replace(coalesce(u.phone,''), '[^0-9]', '', 'g') <> ''
ON CONFLICT(company_id) DO UPDATE SET
  owner_phone = coalesce(nullif(cash_settings.owner_phone,''), excluded.owner_phone),
  updated_at = now();

-- O roteamento do Cash é por remetente; este índice evita varredura completa.
CREATE INDEX IF NOT EXISTS idx_cash_settings_owner_phone_last11
  ON cash_settings ((right(regexp_replace(coalesce(owner_phone,''), '[^0-9]', '', 'g'), 11)));
