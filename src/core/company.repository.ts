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
      timezone,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'key', cc.capability_key,
            'status', cc.status,
            'configuration', cc.configuration
          ) order by cc.capability_key
        )
        from company_capabilities cc
        where cc.company_id = companies.id
      ), '[]'::jsonb) as capabilities
    from companies
    where evolution_instance = $1
    limit 1
    `,
    [instanceName]
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
