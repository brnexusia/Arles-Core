import { db } from '../infrastructure/db.js';
import type { Company, CompanyCapability } from './types.js';

export async function getCompanyByInstance(
  instanceName: string
): Promise<Company | null> {
  const result = await db.query<Omit<Company, 'capabilities'> & { capabilities: CompanyCapability[] | null }>(
    `
    select
      c.id,
      c.name,
      c.slug,
      c.vertical,
      c.evolution_instance,
      c.subscription_status,
      c.access_active,
      c.trial_ends_at,
      c.timezone,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'key', cc.capability_key,
            'status', cc.status,
            'configuration', cc.configuration
          )
        ) filter (where cc.capability_key is not null),
        '[]'::jsonb
      ) as capabilities
    from companies c
    left join company_capabilities cc on cc.company_id = c.id
    where c.evolution_instance = $1
    group by c.id
    limit 1
    `,
    [instanceName]
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    ...row,
    capabilities: Array.isArray(row.capabilities) ? row.capabilities : []
  };
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
