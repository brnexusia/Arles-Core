import { db } from '../infrastructure/db.js';
import { evolution } from './evolution.client.js';

function deterministicInstance(companyId: string): string {
  return `arles-${companyId.replace(/-/g, '').slice(0, 24)}`;
}

export class WhatsappChannelService {
  private async companyInstance(companyId: string): Promise<string> {
    const result = await db.query<{ evolution_instance: string }>(
      "select evolution_instance from companies where id=$1 and vertical='delivery' limit 1",
      [companyId]
    );
    if (!result.rowCount) throw new Error('VERTICAL_DISABLED');
    return result.rows[0]?.evolution_instance || deterministicInstance(companyId);
  }

  async status(companyId: string) {
    const instanceName = await this.companyInstance(companyId);
    const cached = await db.query<{ status: string; phone_number: string | null }>(
      'select status,phone_number from whatsapp_connections where company_id=$1', [companyId]
    );
    try {
      const response = await evolution.connectionState(instanceName);
      const state = response?.instance?.state;
      const status = state === 'open' ? 'connected' : state === 'connecting' ? 'connecting' : 'disconnected';
      const phoneNumber = response?.instance?.owner || cached.rows[0]?.phone_number || null;
      await db.query(
        `update whatsapp_connections set status=$2,phone_number=$3,
         connected_at=case when $2='connected' then coalesce(connected_at,now()) else connected_at end,
         updated_at=now() where company_id=$1`,
        [companyId, status, phoneNumber]
      );
      if (status === 'connected') {
        await db.query("update companies set whatsapp_completed=true,updated_at=now() where id=$1", [companyId]);
      }
      return { status, phoneNumber };
    } catch (error: any) {
      if (error?.status === 404 || String(error?.message).includes('EVOLUTION_GO_INSTANCE_TOKEN_MISSING')) {
        return { status: 'disconnected', phoneNumber: cached.rows[0]?.phone_number || null };
      }
      return {
        status: cached.rows[0]?.status || 'disconnected',
        phoneNumber: cached.rows[0]?.phone_number || null,
        degraded: true
      };
    }
  }

  async connect(companyId: string) {
    const instanceName = await this.companyInstance(companyId);
    // This bootstrap is idempotent and needed by legacy companies created before Go.
    await db.query(
      `insert into whatsapp_connections(company_id,instance_name,status)
       values($1,$2,'disconnected')
       on conflict(company_id) do update set instance_name=excluded.instance_name`,
      [companyId, instanceName]
    );
    let exists = true;
    let state: any = null;
    try {
      state = await evolution.connectionState(instanceName);
    } catch (error: any) {
      if (error?.status === 404 ||
          String(error?.message).includes('EVOLUTION_GO_INSTANCE_TOKEN_MISSING')) exists = false;
      else throw error;
    }
    if (state?.instance?.state === 'open') {
      const phoneNumber = state?.instance?.owner || null;
      await db.query(
        `update whatsapp_connections set phone_number=$2,status='connected',
         connected_at=coalesce(connected_at,now()),updated_at=now() where company_id=$1`,
        [companyId, phoneNumber]
      );
      await db.query('update companies set whatsapp_completed=true,updated_at=now() where id=$1', [companyId]);
      return { success: true, status: 'connected', phoneNumber };
    }

    if (!exists) await evolution.createInstance(instanceName);
    const qr = await evolution.connectInstance(instanceName);
    const qrCodeBase64 = evolution.extractQr(qr);
    await db.query(
      `update whatsapp_connections set instance_name=$2,status='connecting',updated_at=now()
       where company_id=$1`, [companyId, instanceName]
    );
    await db.query('update companies set evolution_instance=$2,updated_at=now() where id=$1',
      [companyId, instanceName]);
    return { success: true, status: 'connecting', qrCodeBase64 };
  }

  async disconnect(companyId: string) {
    const instanceName = await this.companyInstance(companyId);
    await evolution.logoutInstance(instanceName).catch(() => undefined);
    await db.query(
      "update whatsapp_connections set status='disconnected',phone_number=null,updated_at=now() where company_id=$1",
      [companyId]
    );
    await db.query('update companies set whatsapp_completed=false,updated_at=now() where id=$1', [companyId]);
    return { success: true, status: 'disconnected' };
  }
}

export const whatsappChannel = new WhatsappChannelService();
