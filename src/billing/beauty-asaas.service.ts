import { createHash } from 'node:crypto';
import { db } from '../infrastructure/db.js';
import { env } from '../config/env.js';
import { asaas, type AsaasAutomaticPixAuthorization } from './asaas.client.js';

function clean(value: unknown): string { return String(value ?? '').trim(); }
function digits(value: unknown): string { return clean(value).replace(/\D/g, ''); }
function cents(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0;
}
function currentDate(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}
function subscriptionIdFrom(auth: AsaasAutomaticPixAuthorization): string | null {
  const value = auth.subscription;
  if (typeof value === 'string') return value || null;
  return clean(value?.id) || null;
}

export class BeautyAsaasService {
  private async account(companyId: string) {
    const result = await db.query<any>(`select
        c.id::text,c.name,c.timezone,coalesce(c.active_vertical_id,c.vertical) vertical,
        c.subscription_status,c.access_active,c.asaas_customer_id,c.asaas_pix_authorization_id,
        c.asaas_subscription_id,c.asaas_authorization_status,c.monthly_price_cents,
        u.name owner_name,u.email,u.phone
      from companies c
      left join auth_users u on u.company_id=c.id and u.role='user'
      where c.id=$1 limit 1`, [companyId]);
    const row = result.rows[0];
    if (!row) throw new Error('COMPANY_NOT_FOUND');
    if (row.vertical !== 'beauty') throw new Error('BEAUTY_BILLING_ONLY');
    return row;
  }

  async info(companyId: string) {
    const row = await this.account(companyId);
    return {
      provider: 'asaas',
      plan_key: 'beauty',
      plan_name: 'Arles Beauty',
      price_cents: Number(row.monthly_price_cents || env.beautyMonthlyPriceCents),
      subscription_status: row.subscription_status,
      access_active: Boolean(row.access_active),
      authorization_id: row.asaas_pix_authorization_id || null,
      authorization_status: row.asaas_authorization_status || null,
      subscription_id: row.asaas_subscription_id || null,
      customer_id: row.asaas_customer_id || null
    };
  }

  async startActivation(companyId: string, input: { cpf_cnpj?: unknown }) {
    const document = digits(input.cpf_cnpj);
    if (![11, 14].includes(document.length)) throw new Error('CPF_CNPJ_INVALID');
    const account = await this.account(companyId);

    if (account.asaas_pix_authorization_id && ['CREATED','ACTIVE'].includes(String(account.asaas_authorization_status || '').toUpperCase())) {
      const existing = await asaas.getAutomaticPixAuthorization(account.asaas_pix_authorization_id);
      await this.persistAuthorization(companyId, existing);
      return this.activationView(existing);
    }

    let customerId = clean(account.asaas_customer_id);
    if (!customerId) {
      const existingCustomer = await asaas.findCustomer(companyId);
      const customer = existingCustomer ?? await asaas.createCustomer({
        name: clean(account.owner_name) || clean(account.name) || 'Cliente Arles Beauty',
        cpfCnpj: document,
        mobilePhone: digits(account.phone),
        email: clean(account.email) || undefined,
        externalReference: companyId
      });
      customerId = customer.id;
      await db.query(`update companies set asaas_customer_id=$2,billing_provider='asaas',monthly_price_cents=$3,updated_at=now() where id=$1`,
        [companyId,customerId,env.beautyMonthlyPriceCents]);
    }

    const authorization = await asaas.createAutomaticPixAuthorization({
      customerId,
      contractId: `beauty-${companyId.replace(/-/g,'').slice(0,28)}`,
      startDate: currentDate(account.timezone),
      value: env.beautyMonthlyPriceCents / 100
    });
    await this.persistAuthorization(companyId, authorization);
    return this.activationView(authorization);
  }

  async refresh(companyId: string) {
    const account = await this.account(companyId);
    if (!account.asaas_pix_authorization_id) return this.info(companyId);
    const authorization = await asaas.getAutomaticPixAuthorization(account.asaas_pix_authorization_id);
    await this.persistAuthorization(companyId, authorization);
    return { ...(await this.info(companyId)), authorization: this.activationView(authorization) };
  }

  async cancel(companyId: string) {
    const account = await this.account(companyId);
    if (!account.asaas_pix_authorization_id) throw new Error('ASAAS_AUTHORIZATION_NOT_FOUND');
    const authorization = await asaas.cancelAutomaticPixAuthorization(account.asaas_pix_authorization_id);
    await db.query(`update companies set subscription_status='canceled',access_active=false,
      cancel_at_period_end=false,asaas_authorization_status='CANCELLED',updated_at=now() where id=$1`, [companyId]);
    return this.activationView(authorization);
  }

  private activationView(authorization: AsaasAutomaticPixAuthorization) {
    return {
      id: authorization.id,
      status: authorization.status || 'CREATED',
      customer_id: authorization.customerId || null,
      subscription_id: subscriptionIdFrom(authorization),
      immediate_qr_code: authorization.immediateQrCode || null,
      frequency: authorization.frequency || 'MONTHLY',
      value: authorization.value ?? env.beautyMonthlyPriceCents / 100,
      start_date: authorization.startDate || null
    };
  }

  private async persistAuthorization(companyId: string, authorization: AsaasAutomaticPixAuthorization) {
    const status = clean(authorization.status).toUpperCase() || 'CREATED';
    const active = status === 'ACTIVE';
    const mappedStatus = active ? 'active' : status === 'CANCELLED' ? 'canceled' : status === 'EXPIRED' ? 'expired' : 'pending';
    await db.query(`update companies set
        billing_provider='asaas',monthly_price_cents=$3,asaas_pix_authorization_id=$2,
        asaas_authorization_status=$4,asaas_subscription_id=coalesce($5,asaas_subscription_id),
        subscription_status=$6,access_active=$7,
        subscription_started_at=case when $7 then coalesce(subscription_started_at,now()) else subscription_started_at end,
        updated_at=now()
      where id=$1`, [companyId,authorization.id,env.beautyMonthlyPriceCents,status,subscriptionIdFrom(authorization),mappedStatus,active]);
  }

  private fallbackEventId(payload: any): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(payload ?? {})).digest('hex')}`;
  }

  async applyWebhook(payload: any): Promise<{ duplicate: boolean; companyId?: string }> {
    const eventId = clean(payload?.id) || this.fallbackEventId(payload);
    const eventType = clean(payload?.event) || 'UNKNOWN';
    const authorizationId = clean(payload?.authorization?.id || payload?.paymentInstruction?.authorization?.id);
    const customerId = clean(payload?.authorization?.customerId || payload?.payment?.customer?.id || payload?.payment?.customer);
    const paymentId = clean(payload?.payment?.id || payload?.paymentInstruction?.paymentId || payload?.paymentInstruction?.payment);
    const resourceId = authorizationId || paymentId || clean(payload?.paymentInstruction?.id) || null;

    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`asaas:${eventId}`]);
      const inserted = await client.query(`insert into asaas_events(id,event_type,resource_id,payload)
        values($1,$2,$3,$4::jsonb) on conflict(id) do nothing returning id`, [eventId,eventType,resourceId,JSON.stringify(payload ?? {})]);
      if (!inserted.rowCount) {
        await client.query('commit');
        return { duplicate: true };
      }

      let companyId: string | undefined;
      const company = await client.query<any>(`select id::text from companies
        where coalesce(active_vertical_id,vertical)='beauty' and (
          ($1<>'' and asaas_pix_authorization_id=$1) or ($2<>'' and asaas_customer_id=$2)
        ) limit 1`, [authorizationId,customerId]);
      companyId = company.rows[0]?.id;

      if (companyId) {
        if (eventType.startsWith('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_')) {
          const status = clean(payload?.authorization?.status).toUpperCase() ||
            (eventType.endsWith('_ACTIVATED') ? 'ACTIVE' : eventType.endsWith('_CANCELLED') ? 'CANCELLED' : eventType.endsWith('_EXPIRED') ? 'EXPIRED' : eventType.endsWith('_REFUSED') ? 'REFUSED' : 'CREATED');
          const subscriptionStatus = status === 'ACTIVE' ? 'active' : status === 'CANCELLED' ? 'canceled' : status === 'EXPIRED' ? 'expired' : 'pending';
          await client.query(`update companies set asaas_authorization_status=$2,
              asaas_pix_authorization_id=coalesce(nullif($3,''),asaas_pix_authorization_id),
              subscription_status=$4,access_active=$5,
              subscription_started_at=case when $5 then coalesce(subscription_started_at,now()) else subscription_started_at end,
              updated_at=now()
            where id=$1`, [companyId,status,authorizationId,subscriptionStatus,status==='ACTIVE']);
        }

        if (eventType.startsWith('PAYMENT_') && payload?.payment) {
          const valueCents = cents(payload.payment.value);
          const status = clean(payload.payment.status || eventType.replace(/^PAYMENT_/,''));
          const paid = /RECEIVED|CONFIRMED/.test(eventType);
          const overdue = /OVERDUE|REFUNDED|CHARGEBACK|REPROVED/.test(eventType);
          if (paymentId) {
            await client.query(`insert into beauty_billing_payments(company_id,asaas_payment_id,status,value_cents,due_date,paid_at,payload)
              values($1,$2,$3,$4,$5,$6,$7::jsonb)
              on conflict(asaas_payment_id) do update set status=excluded.status,value_cents=excluded.value_cents,
                due_date=excluded.due_date,paid_at=coalesce(excluded.paid_at,beauty_billing_payments.paid_at),payload=excluded.payload,updated_at=now()`,
              [companyId,paymentId,status,valueCents,payload.payment.dueDate||null,paid?new Date():null,JSON.stringify(payload.payment)]);
          }
          if (paid) {
            await client.query(`update companies set subscription_status='active',access_active=true,
              subscription_started_at=coalesce(subscription_started_at,now()),updated_at=now() where id=$1`, [companyId]);
          } else if (overdue) {
            await client.query(`update companies set subscription_status='past_due',access_active=false,updated_at=now() where id=$1`, [companyId]);
          }
        }
      }

      await client.query(`update asaas_events set processed_at=now() where id=$1`, [eventId]);
      await client.query('commit');
      return { duplicate: false, companyId };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }
}

export const beautyAsaasService = new BeautyAsaasService();
