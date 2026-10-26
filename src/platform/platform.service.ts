import { db } from '../infrastructure/db.js';
import { moduleRegistry } from './modules/registry.js';
import { whatsappChannel } from '../whatsapp/channel.service.js';

function clean(value: unknown): string {
  return String(value ?? '').trim();
}

export class PlatformService {
  private async assertDelivery(companyId: string): Promise<void> {
    const result = await db.query<{ vertical: string }>(
      'select vertical from companies where id=$1 limit 1', [companyId]
    );
    if (result.rows[0]?.vertical !== 'delivery') throw new Error('VERTICAL_DISABLED');
  }


  async company(companyId: string) {
    const result = await db.query(
      `select id::text,name,vertical,store_info_completed,whatsapp_completed,
              onboarding_completed,subscription_status,trial_started_at,
              trial_ends_at,instagram,logo_url
       from companies where id=$1 limit 1`,
      [companyId]
    );
    const company = result.rows[0];
    if (!company) throw new Error('COMPANY_NOT_FOUND');
    return company;
  }

  async capabilities(companyId: string) {
    const result = await db.query<{
      capability_key: string;
      status: string;
      configuration: Record<string, unknown>;
    }>(
      `select capability_key,status,configuration
       from company_capabilities
       where company_id=$1
       order by capability_key`,
      [companyId]
    );
    return result.rows.map(row => ({
      key: row.capability_key,
      status: row.status,
      configuration: row.configuration ?? {}
    }));
  }

  async manifest(companyId: string) {
    const capabilities = await this.capabilities(companyId);
    const active = new Set(
      capabilities.filter(item => item.status === 'active').map(item => item.key)
    );
    const modules = moduleRegistry.list()
      .filter(module => module.capabilities.some(capability => active.has(capability.key)))
      .map(module => ({
        key: module.key,
        metadata: module.metadata,
        capability: module.capabilities.find(capability => active.has(capability.key))?.key,
        onboardingSteps: module.onboardingSteps ?? [],
        ui: module.ui ?? null
      }));
    return { capabilities, modules };
  }

  async onboarding(companyId: string) {
    const [company, manifest, progress] = await Promise.all([
      this.company(companyId),
      this.manifest(companyId),
      db.query<{ step_key: string; capability_key: string | null; status: string; state: Record<string, unknown> }>(
        `select step_key,capability_key,status,state
         from onboarding_progress where company_id=$1`,
        [companyId]
      )
    ]);

    const registered = manifest.modules
      .flatMap(module => module.onboardingSteps)
      .sort((a, b) => a.order - b.order);
    const state = new Map(progress.rows.map(row => [row.step_key, row]));

    return {
      completed: company.onboarding_completed === true,
      steps: registered.map(step => ({
        ...step,
        status: state.get(step.key)?.status ?? 'pending',
        state: state.get(step.key)?.state ?? {}
      }))
    };
  }

  async completeOnboarding(companyId: string, stepKeys: string[] = []): Promise<void> {
    const manifest = await this.manifest(companyId);
    const validSteps = new Map(
      manifest.modules.flatMap(module => module.onboardingSteps).map(step => [step.key, step])
    );
    const targets = stepKeys.length ? stepKeys : [...validSteps.keys()];
    const client = await db.connect();
    try {
      await client.query('begin');
      for (const key of targets) {
        const step = validSteps.get(key);
        if (!step) throw new Error(`ONBOARDING_STEP_INVALID:${key}`);
        await client.query(
          `insert into onboarding_progress(
             company_id,step_key,capability_key,status,completed_at,updated_at
           ) values($1,$2,$3,'completed',now(),now())
           on conflict(company_id,step_key) do update set
             status='completed',completed_at=now(),updated_at=now()`,
          [companyId, key, step.capabilityKey ?? null]
        );
      }
      if (!stepKeys.length) {
        await client.query(
          `update companies set onboarding_completed=true,updated_at=now() where id=$1`,
          [companyId]
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async listCustomers(companyId: string) {
    const result = await db.query(
      `select id::text,company_id::text,name,phone_number,notes,
              first_seen_at,last_seen_at,created_at,updated_at
       from customers where company_id=$1 order by last_seen_at desc`,
      [companyId]
    );
    return result.rows;
  }

  async updateCustomerNotes(companyId: string, customerId: string, notes: string) {
    const result = await db.query(
      `update customers set notes=$3,updated_at=now()
       where id=$2 and company_id=$1
       returning id::text,company_id::text,name,phone_number,notes,
                 first_seen_at,last_seen_at,created_at,updated_at`,
      [companyId, customerId, notes.trim() || null]
    );
    if (!result.rows[0]) throw new Error('CUSTOMER_NOT_FOUND');
    return result.rows[0];
  }

  async settings(companyId: string) {
    const result = await db.query<{ config: Record<string, unknown>; instagram: string | null }>(
      `select coalesce(s.config,'{}'::jsonb) as config,c.instagram
       from companies c left join company_settings s on s.company_id=c.id
       where c.id=$1 limit 1`,
      [companyId]
    );
    const row = result.rows[0];
    return row ? { ...row.config, instagram: row.instagram ?? '' } : {};
  }

  async saveSettings(companyId: string, body: Record<string, unknown>) {
    const config = {
      display_name: clean(body.display_name),
      phone: clean(body.phone),
      email: clean(body.email),
      notifications_sound: body.notifications_sound !== false
    };
    const instagram = clean(body.instagram);
    await db.query(
      `insert into company_settings(company_id,config,updated_at)
       values($1,$2::jsonb,now())
       on conflict(company_id) do update set config=excluded.config,updated_at=now()`,
      [companyId, JSON.stringify(config)]
    );
    await db.query(
      `update companies set instagram=$2,updated_at=now() where id=$1`,
      [companyId, instagram || null]
    );
    return { ...config, instagram };
  }

  async channelStatus(companyId: string) {
    await this.assertDelivery(companyId);
    return whatsappChannel.status(companyId);
  }

  async connectChannel(companyId: string) {
    await this.assertDelivery(companyId);
    return whatsappChannel.connect(companyId);
  }

  async disconnectChannel(companyId: string) {
    await this.assertDelivery(companyId);
    return whatsappChannel.disconnect(companyId);
  }

}

export const platformService = new PlatformService();
