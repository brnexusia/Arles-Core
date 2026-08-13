import { db } from '../infrastructure/db.js';
import { env } from '../config/env.js';
import { evolution } from '../whatsapp/evolution.client.js';
import { moduleRegistry } from './modules/registry.js';

function clean(value: unknown): string {
  return String(value ?? '').trim();
}

function deterministicInstance(companyId: string): string {
  return `arles-${companyId.replace(/-/g, '').slice(0, 24)}`;
}

export class PlatformService {
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
    const company = await db.query<{ evolution_instance: string }>(
      `select evolution_instance from companies where id=$1 limit 1`,
      [companyId]
    );
    const instanceName = company.rows[0]?.evolution_instance;
    if (!instanceName) return { status: 'disconnected', phoneNumber: null };
    const cached = await db.query(
      `select * from whatsapp_connections where company_id=$1 limit 1`,
      [companyId]
    );
    try {
      if (env.publicBaseUrl) {
        await evolution.setWebhook(instanceName, `${env.publicBaseUrl}/webhooks/evolution`).catch(() => undefined);
      }
      const state = await evolution.connectionState(instanceName);
      const rawState = state?.instance?.state;
      const status = rawState === 'open' ? 'connected' : rawState === 'connecting' ? 'connecting' : 'disconnected';
      const phoneNumber = state?.instance?.owner || cached.rows[0]?.phone_number || null;
      await db.query(
        `insert into whatsapp_connections(company_id,instance_name,phone_number,status,connected_at,updated_at)
         values($1,$2,$3,$4,case when $4='connected' then now() else null end,now())
         on conflict(company_id) do update set
           phone_number=coalesce(excluded.phone_number,whatsapp_connections.phone_number),
           status=excluded.status,
           connected_at=case when excluded.status='connected' then coalesce(whatsapp_connections.connected_at,now()) else whatsapp_connections.connected_at end,
           updated_at=now()`,
        [companyId, instanceName, phoneNumber, status]
      );
      if (status === 'connected') {
        await db.query(`update companies set whatsapp_completed=true,updated_at=now() where id=$1`, [companyId]);
      }
      return { status, phoneNumber };
    } catch (error: any) {
      if (error?.status === 404) return { status: 'disconnected', phoneNumber: null };
      return {
        status: cached.rows[0]?.status || 'disconnected',
        phoneNumber: cached.rows[0]?.phone_number || null,
        degraded: true
      };
    }
  }

  async connectChannel(companyId: string) {
    const company = await db.query<{ evolution_instance: string }>(
      `select evolution_instance from companies where id=$1 limit 1`,
      [companyId]
    );
    const instanceName = company.rows[0]?.evolution_instance || deterministicInstance(companyId);
    const webhookUrl = env.publicBaseUrl ? `${env.publicBaseUrl}/webhooks/evolution` : '';
    let exists = true;
    let state: any = null;
    try {
      state = await evolution.connectionState(instanceName);
    } catch (error: any) {
      if (error?.status === 404) exists = false;
      else throw error;
    }
    if (state?.instance?.state === 'open') {
      const phoneNumber = state?.instance?.owner || null;
      await db.query(`update companies set whatsapp_completed=true,updated_at=now() where id=$1`, [companyId]);
      await db.query(
        `insert into whatsapp_connections(company_id,instance_name,phone_number,status,connected_at,updated_at)
         values($1,$2,$3,'connected',now(),now())
         on conflict(company_id) do update set phone_number=excluded.phone_number,status='connected',connected_at=coalesce(whatsapp_connections.connected_at,now()),updated_at=now()`,
        [companyId, instanceName, phoneNumber]
      );
      return { success: true, status: 'connected', phoneNumber };
    }
    let qrCodeBase64: string | null = null;
    if (!exists) qrCodeBase64 = evolution.extractQr(await evolution.createInstance(instanceName, webhookUrl));
    if (webhookUrl) await evolution.setWebhook(instanceName, webhookUrl).catch(() => undefined);
    if (!qrCodeBase64) qrCodeBase64 = evolution.extractQr(await evolution.connectInstance(instanceName));
    await db.query(
      `insert into whatsapp_connections(company_id,instance_name,status,updated_at)
       values($1,$2,'connecting',now())
       on conflict(company_id) do update set instance_name=excluded.instance_name,status='connecting',updated_at=now()`,
      [companyId, instanceName]
    );
    await db.query(`update companies set evolution_instance=$2,updated_at=now() where id=$1`, [companyId, instanceName]);
    return { success: true, status: 'connecting', qrCodeBase64 };
  }

  async disconnectChannel(companyId: string) {
    const company = await db.query<{ evolution_instance: string }>(
      `select evolution_instance from companies where id=$1 limit 1`,
      [companyId]
    );
    if (company.rows[0]?.evolution_instance) {
      await evolution.logoutInstance(company.rows[0].evolution_instance).catch(() => undefined);
    }
    await db.query(
      `update whatsapp_connections set status='disconnected',phone_number=null,updated_at=now() where company_id=$1`,
      [companyId]
    );
    await db.query(`update companies set whatsapp_completed=false,updated_at=now() where id=$1`, [companyId]);
    return { success: true, status: 'disconnected' };
  }
}

export const platformService = new PlatformService();
