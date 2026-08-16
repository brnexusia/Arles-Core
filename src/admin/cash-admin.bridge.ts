import { db } from '../infrastructure/db.js';
import { adminService } from './admin.service.js';

function normalizedEmail(value: unknown): string | null {
  const email = String(value ?? '').trim().toLowerCase();
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('ADMIN_EMAIL_INVALID');
  return email;
}

export async function cashOverviewWithOwnerEmail() {
  const overview = await adminService.cashOverview();
  const users = Array.isArray(overview.cashUsers) ? overview.cashUsers : [];
  if (!users.length) return overview;

  const companyIds = users.map(user => String(user.id));
  const result = await db.query<{ company_id: string; owner_email: string | null }>(
    `select company_id::text as company_id, owner_email
     from cash_settings
     where company_id::text = any($1::text[])`,
    [companyIds]
  );
  const cashEmails = new Map(
    result.rows.map(row => [row.company_id, String(row.owner_email ?? '').trim().toLowerCase() || null])
  );

  return {
    ...overview,
    cashUsers: users.map(user => ({
      ...user,
      // O Cash nasce no WhatsApp e o onboarding grava o e-mail em cash_settings.
      // auth_users pode nem existir para essa conta, então cash_settings é a fonte principal.
      ownerEmail: cashEmails.get(String(user.id)) || user.ownerEmail || null
    }))
  };
}

export async function updateCashUserWithOwnerEmail(
  companyId: string,
  body: Record<string, unknown>
) {
  const email = body.email === undefined ? undefined : normalizedEmail(body.email);

  if (email) {
    const duplicate = await db.query(
      `select 1
       from cash_settings
       where company_id <> $1
         and lower(coalesce(owner_email, '')) = $2
       limit 1`,
      [companyId, email]
    );
    if (duplicate.rowCount) throw new Error('ADMIN_EMAIL_IN_USE');
  }

  const updated = await adminService.updateCashUser(companyId, body);

  if (email) {
    await db.query(
      `insert into cash_settings(company_id, owner_email)
       values($1, $2)
       on conflict(company_id) do update set
         owner_email = excluded.owner_email,
         updated_at = now()`,
      [companyId, email]
    );
  }

  return updated;
}
