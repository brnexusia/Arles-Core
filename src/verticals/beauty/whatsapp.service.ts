import { db } from '../../infrastructure/db.js';
import { env } from '../../config/env.js';
import { beautyEvolutionClusters, beautyEvolutionHealth, chooseBeautyEvolutionCluster, evolutionForCluster } from '../../whatsapp/evolution.router.js';

function stateFrom(data: any): string {
  return String(data?.instance?.state ?? data?.state ?? data?.connectionStatus ?? data?.status ?? '').toLowerCase();
}
function normalizedStatus(state: string): string {
  if (state === 'open' || state === 'connected') return 'connected';
  if (state === 'connecting') return 'connecting';
  if (state === 'close' || state === 'closed' || state === 'disconnected') return 'disconnected';
  return state || 'disconnected';
}

export class BeautyWhatsAppService {
  private async connection(companyId: string) {
    const result = await db.query<any>(`select c.id::text,c.evolution_instance,c.evolution_cluster,
      w.instance_id,w.phone_number,w.status,w.connected_at,w.last_connected_at,w.last_disconnected_at,w.reconnect_count,w.last_error
      from companies c left join whatsapp_connections w on w.company_id=c.id
      where c.id=$1 and coalesce(c.active_vertical_id,c.vertical)='beauty' limit 1`, [companyId]);
    const row = result.rows[0];
    if (!row) throw new Error('BEAUTY_COMPANY_NOT_FOUND');
    return row;
  }

  private freshConnection(row: any): boolean {
    return !row.evolution_cluster && !row.instance_id && !row.phone_number && !row.connected_at && !row.last_connected_at && ['','disconnected'].includes(String(row.status || '').toLowerCase());
  }

  async status(companyId: string) {
    const row = await this.connection(companyId);
    const client = evolutionForCluster(row.evolution_cluster || null);
    let state = 'disconnected';
    let error: string | null = null;
    try {
      const data = await client.connectionState(row.evolution_instance);
      state = normalizedStatus(stateFrom(data));
    } catch (err: any) {
      if (Number(err?.status) !== 404) error = err instanceof Error ? err.message : String(err);
    }
    await db.query(`insert into whatsapp_connections(company_id,instance_name,cluster_key,status,last_error,updated_at)
      values($1,$2,$3,$4,$5,now()) on conflict(company_id) do update set
      instance_name=excluded.instance_name,cluster_key=excluded.cluster_key,status=excluded.status,last_error=excluded.last_error,
      last_connected_at=case when excluded.status='connected' then now() else whatsapp_connections.last_connected_at end,
      last_disconnected_at=case when excluded.status='disconnected' and whatsapp_connections.status<>'disconnected' then now() else whatsapp_connections.last_disconnected_at end,
      updated_at=now()`, [companyId,row.evolution_instance,row.evolution_cluster||null,state,error]);
    return {
      instance: row.evolution_instance,
      cluster: row.evolution_cluster || 'default',
      phone_number: row.phone_number || null,
      status: state,
      connection_status: state,
      last_error: error
    };
  }

  async connect(companyId: string) {
    let row = await this.connection(companyId);
    let clusterKey: string | null = row.evolution_cluster || null;

    // Never migrate an existing/suspected session automatically. Only brand-new
    // Beauty connections are allocated to a shard. This protects all numbers that
    // may already live in the legacy Evolution.
    if (this.freshConnection(row) && beautyEvolutionClusters().length) {
      clusterKey = await chooseBeautyEvolutionCluster();
      await db.query(`update companies set evolution_cluster=$2,updated_at=now() where id=$1`, [companyId,clusterKey]);
      await db.query(`update whatsapp_connections set cluster_key=$2,updated_at=now() where company_id=$1`, [companyId,clusterKey]);
      row = { ...row, evolution_cluster: clusterKey };
    }

    const client = evolutionForCluster(clusterKey);
    const webhookUrl = env.publicBaseUrl ? `${env.publicBaseUrl}/webhooks/evolution` : '';
    let stateData: any = null;
    try { stateData = await client.connectionState(row.evolution_instance); } catch (error: any) {
      if (Number(error?.status) !== 404) throw error;
    }

    let response: any = stateData;
    if (!stateData) {
      response = await client.createInstance(row.evolution_instance, webhookUrl);
    } else if (webhookUrl) {
      await client.setWebhook(row.evolution_instance, webhookUrl).catch(() => undefined);
    }

    const currentState = normalizedStatus(stateFrom(response || stateData));
    if (currentState !== 'connected') {
      try { response = await client.connectInstance(row.evolution_instance); }
      catch (error: any) {
        await db.query(`update whatsapp_connections set status='disconnected',last_error=$2,reconnect_count=reconnect_count+1,updated_at=now() where company_id=$1`, [companyId,error instanceof Error?error.message:String(error)]);
        throw error;
      }
    }

    const qr = client.extractQr(response) || client.extractQr(await client.connectInstance(row.evolution_instance).catch(() => null));
    const finalState = normalizedStatus(stateFrom(response));
    await db.query(`insert into whatsapp_connections(company_id,instance_name,cluster_key,status,last_error,updated_at)
      values($1,$2,$3,$4,null,now()) on conflict(company_id) do update set
      instance_name=excluded.instance_name,cluster_key=excluded.cluster_key,status=excluded.status,last_error=null,
      reconnect_count=case when whatsapp_connections.status='disconnected' then whatsapp_connections.reconnect_count+1 else whatsapp_connections.reconnect_count end,
      updated_at=now()`, [companyId,row.evolution_instance,clusterKey,finalState==='connected'?'connected':'connecting']);

    return {
      instance: row.evolution_instance,
      cluster: clusterKey || 'default',
      status: finalState === 'connected' ? 'connected' : 'connecting',
      qr_code: qr
    };
  }

  async disconnect(companyId: string) {
    const row = await this.connection(companyId);
    const client = evolutionForCluster(row.evolution_cluster || null);
    await client.logoutInstance(row.evolution_instance).catch((error: any) => {
      if (![400,404].includes(Number(error?.status))) throw error;
    });
    await db.query(`update whatsapp_connections set status='disconnected',last_disconnected_at=now(),last_error=null,updated_at=now() where company_id=$1`, [companyId]);
    return { ok: true, instance: row.evolution_instance, cluster: row.evolution_cluster || 'default', status: 'disconnected' };
  }

  async clusterHealth() {
    return beautyEvolutionHealth();
  }
}

export const beautyWhatsAppService = new BeautyWhatsAppService();
