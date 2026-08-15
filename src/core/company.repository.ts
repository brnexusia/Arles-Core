import { db } from '../infrastructure/db.js';
import type { Company } from './types.js';

export async function getCompanyByInstance(
  instanceName: string
): Promise<Company | null> {
  const result = await db.query<Company>(
    `
    select
      id,
      name,
      slug,
      coalesce(active_vertical_id, vertical) as vertical,
      evolution_instance,
      subscription_status,
      access_active,
      trial_ends_at,
      timezone
    from companies
    where evolution_instance = $1
    limit 1
    `,
    [instanceName]
  );

  return result.rows[0] ?? null;
}


function digits(value: string): string {
  return String(value ?? '').replace(/\D/g, '');
}

export async function getCashCompanyByOwnerPhone(
  phone: string
): Promise<Company | null> {
  const normalized = digits(phone);
  if (normalized.length < 10) return null;

  const result = await db.query<Company>(
    `
    select
      c.id,
      c.name,
      c.slug,
      coalesce(c.active_vertical_id, c.vertical) as vertical,
      c.evolution_instance,
      c.subscription_status,
      c.access_active,
      c.trial_ends_at,
      c.timezone
    from cash_settings cs
    join companies c on c.id = cs.company_id
    where coalesce(c.active_vertical_id, c.vertical) = 'cash'
      and (
        regexp_replace(coalesce(cs.owner_phone,''), '[^0-9]', '', 'g') = $1
        or right(regexp_replace(coalesce(cs.owner_phone,''), '[^0-9]', '', 'g'), 11) = right($1, 11)
      )
    order by c.created_at desc
    limit 1
    `,
    [normalized]
  );

  return result.rows[0] ?? null;
}

export function companyCanUseEngine(company: Company): boolean {
  if (!company.access_active) return false;

  const status = String(company.subscription_status).toLowerCase();

  if (status === 'active') return true;

  if (status === 'trial') {
    return !company.trial_ends_at || company.trial_ends_at.getTime() > Date.now();
  }

  return false;
}
