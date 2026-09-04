import { db } from '../infrastructure/db.js';

function clean(value: unknown, max = 500): string {
  return String(value ?? '').trim().slice(0, max);
}

export type BeautyAcquisition = {
  source?: unknown;
  medium?: unknown;
  campaign?: unknown;
  content?: unknown;
  term?: unknown;
  fbclid?: unknown;
  fbp?: unknown;
  fbc?: unknown;
  landing_url?: unknown;
  referrer?: unknown;
};

function normalize(input: BeautyAcquisition | null | undefined) {
  return {
    source: clean(input?.source, 120),
    medium: clean(input?.medium, 120),
    campaign: clean(input?.campaign, 200),
    content: clean(input?.content, 200),
    term: clean(input?.term, 200),
    fbclid: clean(input?.fbclid, 500),
    fbp: clean(input?.fbp, 255),
    fbc: clean(input?.fbc, 255),
    landing_url: clean(input?.landing_url, 1000),
    referrer: clean(input?.referrer, 1000),
    captured_at: new Date().toISOString()
  };
}

export async function finalizeBeautyRegistration(companyId: string, acquisition?: BeautyAcquisition) {
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(`update companies set
      billing_provider='asaas',
      monthly_price_cents=4990,
      subscription_status='pending',
      access_active=false,
      trial_started_at=null,
      trial_ends_at=null,
      acquisition=$2::jsonb,
      updated_at=now()
      where id=$1 and coalesce(active_vertical_id,vertical)='beauty'`,
      [companyId, JSON.stringify(normalize(acquisition))]);
    await client.query('delete from trial_entitlements where company_id=$1', [companyId]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
