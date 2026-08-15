import { db } from '../infrastructure/db.js';
import type { Company } from './types.js';

const COMPANY_SELECT = `
  id,
  name,
  slug,
  coalesce(active_vertical_id, vertical) as vertical,
  evolution_instance,
  subscription_status,
  access_active,
  trial_ends_at,
  timezone
`;

export async function getCompanyByInstance(
  instanceName: string
): Promise<Company | null> {
  const result = await db.query<Company>(
    `select ${COMPANY_SELECT}
     from companies
     where evolution_instance = $1
     limit 1`,
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
    `select
       c.id,
       c.name,
       c.slug,
       coalesce(c.active_vertical_id,c.vertical) as vertical,
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
     limit 1`,
    [normalized]
  );

  return result.rows[0] ?? null;
}

export async function getOrCreateCashCompanyByOwnerPhone(phone: string): Promise<{
  company: Company;
  created: boolean;
}> {
  const normalized = digits(phone);
  if (normalized.length < 10) throw new Error('CASH_PHONE_INVALID');

  const existing = await getCashCompanyByOwnerPhone(normalized);
  if (existing) return { company: existing, created: false };

  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`cash:${normalized.slice(-11)}`]);

    const found = await client.query<Company>(
      `select
         c.id,c.name,c.slug,coalesce(c.active_vertical_id,c.vertical) as vertical,
         c.evolution_instance,c.subscription_status,c.access_active,c.trial_ends_at,c.timezone
       from cash_settings cs
       join companies c on c.id=cs.company_id
       where coalesce(c.active_vertical_id,c.vertical)='cash'
         and right(regexp_replace(coalesce(cs.owner_phone,''),'[^0-9]','','g'),11)=right($1,11)
       order by c.created_at desc limit 1`,
      [normalized]
    );
    if (found.rows[0]) {
      await client.query('commit');
      return { company: found.rows[0], created: false };
    }

    const idResult = await client.query<{ id: string }>(`select gen_random_uuid()::text as id`);
    const companyId = idResult.rows[0]!.id;
    const suffix = normalized.slice(-11);
    const shortId = companyId.slice(0, 8);
    const startedAt = new Date();
    const trialEndsAt = new Date(startedAt.getTime() + 7 * 86_400_000);

    await client.query(
      `insert into companies(
         id,name,slug,vertical,active_vertical_id,evolution_instance,
         subscription_status,access_active,trial_started_at,trial_ends_at,timezone
       ) values($1,$2,$3,'cash','cash',$4,'trial',true,$5,$6,'America/Sao_Paulo')`,
      [
        companyId,
        'Arles Cash',
        `cash-${suffix}-${shortId}`,
        `cash-shared-${suffix}-${shortId}`,
        startedAt,
        trialEndsAt
      ]
    );

    await client.query(
      `insert into cash_settings(company_id,owner_phone,onboarding_state)
       values($1,$2,'welcome')`,
      [companyId, normalized]
    );

    await client.query(
      `insert into company_verticals(company_id,vertical_id,enabled,onboarding_completed)
       values($1,'cash',true,false)
       on conflict(company_id,vertical_id) do nothing`,
      [companyId]
    );

    for (const capability of ['vertical.cash', 'cash.transactions', 'cash.summaries', 'cash.settings']) {
      await client.query(
        `insert into company_capabilities(company_id,capability_key,status)
         values($1,$2,'active')
         on conflict(company_id,capability_key) do update set status='active',updated_at=now()`,
        [companyId, capability]
      );
    }

    // Mantém compatibilidade com a tabela global de trials sem sobrescrever
    // um entitlement que possa pertencer a outra vertical/produto.
    await client.query(
      `insert into trial_entitlements(company_id,phone_normalized,trial_started_at,trial_ends_at)
       values($1,$2,$3,$4)
       on conflict(phone_normalized) do nothing`,
      [companyId, normalized, startedAt, trialEndsAt]
    );

    const created = await client.query<Company>(
      `select ${COMPANY_SELECT} from companies where id=$1 limit 1`,
      [companyId]
    );

    await client.query('commit');
    return { company: created.rows[0]!, created: true };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
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
