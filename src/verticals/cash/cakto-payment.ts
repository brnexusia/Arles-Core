import type { PoolClient } from 'pg';
import { db } from '../../infrastructure/db.js';
import { env } from '../../config/env.js';
import type { CashPlanKey } from './checkout.js';

function digits(value: string): string {
  return String(value ?? '').replace(/\D/g, '').slice(0, 20);
}

function right11(value: string): string {
  return digits(value).slice(-11);
}

function normalizeEmail(value: string): string {
  return String(value ?? '').trim().toLowerCase().slice(0, 254);
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

function planMonths(planKey: CashPlanKey): number {
  if (planKey === 'cash_monthly') return 1;
  if (planKey === 'cash_semiannual') return 6;
  return 12;
}

export function cashPlanLabel(planKey: string | null): string {
  if (planKey === 'cash_monthly') return 'Mensal';
  if (planKey === 'cash_semiannual') return 'Semestral';
  if (planKey === 'cash_annual') return 'Anual';
  return 'Arles Cash';
}

export function companyIdFromSck(value: string): string | null {
  const match = String(value ?? '').trim().match(/^arlescash:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export function resolveCaktoPlan(input: {
  offerId?: string;
  offerName?: string;
  productName?: string;
  amountCents?: number | null;
  currentPlan?: string | null;
}): CashPlanKey | null {
  const offerId = String(input.offerId ?? '').trim();
  if (offerId && env.cashCaktoMonthlyOfferId && offerId === env.cashCaktoMonthlyOfferId) return 'cash_monthly';
  if (offerId && env.cashCaktoSemiannualOfferId && offerId === env.cashCaktoSemiannualOfferId) return 'cash_semiannual';
  if (offerId && env.cashCaktoAnnualOfferId && offerId === env.cashCaktoAnnualOfferId) return 'cash_annual';

  const label = `${input.offerName ?? ''} ${input.productName ?? ''}`.toLowerCase();
  if (/semestral|6\s*mes/.test(label)) return 'cash_semiannual';
  if (/anual|12\s*mes/.test(label)) return 'cash_annual';
  if (/mensal|1\s*mes/.test(label)) return 'cash_monthly';

  // Fallback apenas para facilitar a implantação. Em produção, os IDs de oferta
  // devem ser configurados para não depender de preço/nome.
  if (input.amountCents === 499 || input.amountCents === 500) return 'cash_monthly';
  if (input.amountCents === 2490) return 'cash_semiannual';
  if (input.amountCents === 3990) return 'cash_annual';

  if (input.currentPlan === 'cash_monthly' || input.currentPlan === 'cash_semiannual' || input.currentPlan === 'cash_annual') {
    return input.currentPlan;
  }
  return null;
}

type CashAccount = {
  id: string;
  owner_phone: string | null;
  owner_email: string | null;
  plan_key: string | null;
  subscription_current_period_end: Date | null;
  access_active: boolean;
};

async function findAccount(client: PoolClient, input: {
  companyId?: string | null;
  phone?: string | null;
  email?: string | null;
}): Promise<CashAccount | null> {
  const companyId = String(input.companyId ?? '').trim();
  const phone = digits(input.phone ?? '');
  const email = normalizeEmail(input.email ?? '');

  const result = await client.query<CashAccount>(
    `select
       c.id::text,cs.owner_phone,cs.owner_email,c.plan_key,
       c.subscription_current_period_end,c.access_active
     from companies c
     left join cash_settings cs on cs.company_id=c.id
     where coalesce(c.active_vertical_id,c.vertical)='cash'
       and (
         ($1::text <> '' and c.id::text=$1)
         or ($2::text <> '' and right(regexp_replace(coalesce(cs.owner_phone,''),'[^0-9]','','g'),11)=right($2,11))
         or ($3::text <> '' and lower(coalesce(cs.owner_email,''))=$3)
       )
     order by
       case
         when c.id::text=$1 then 0
         when $2::text <> '' and right(regexp_replace(coalesce(cs.owner_phone,''),'[^0-9]','','g'),11)=right($2,11) then 1
         else 2
       end
     limit 1`,
    [companyId, phone, email]
  );
  return result.rows[0] ?? null;
}

function validFutureDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) return null;
  return parsed;
}

export type CaktoPaymentInput = {
  eventType: string;
  orderId: string;
  sck?: string | null;
  phone?: string | null;
  email?: string | null;
  offerId?: string | null;
  offerName?: string | null;
  productId?: string | null;
  productName?: string | null;
  subscriptionId?: string | null;
  nextPaymentDate?: string | null;
  amountCents?: number | null;
  payload?: Record<string, unknown>;
};

export type CaktoPaymentResult = {
  ignored?: boolean;
  duplicate?: boolean;
  companyId?: string;
  ownerPhone?: string | null;
  ownerEmail?: string | null;
  planKey?: CashPlanKey | null;
  periodEnd?: Date | null;
  activated?: boolean;
  revoked?: boolean;
  canceledAtPeriodEnd?: boolean;
  renewalRefused?: boolean;
};

async function saveEvent(client: PoolClient, input: {
  id: string;
  eventType: string;
  orderId: string;
  company: CashAccount;
  ownerPhone: string;
  ownerEmail: string;
  planKey: CashPlanKey | null;
  offerId: string;
  subscriptionId: string;
  amountCents: number | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  await client.query(
    `insert into cash_payment_events(
       id,provider,company_id,owner_phone,owner_email,plan_key,status,amount_cents,payload,
       provider_event_type,provider_order_id,provider_offer_id,provider_subscription_id
     ) values($1,'cakto',$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)`,
    [
      input.id,
      input.company.id,
      input.ownerPhone || input.company.owner_phone || null,
      input.ownerEmail || input.company.owner_email || null,
      input.planKey,
      input.eventType,
      input.amountCents,
      JSON.stringify(input.payload),
      input.eventType,
      input.orderId || null,
      input.offerId || null,
      input.subscriptionId || null
    ]
  );
}

export class CaktoPaymentService {
  async process(input: CaktoPaymentInput): Promise<CaktoPaymentResult> {
    const eventType = String(input.eventType ?? '').trim().toLowerCase();
    const orderId = String(input.orderId ?? '').trim();
    const subscriptionId = String(input.subscriptionId ?? '').trim();
    const companyId = companyIdFromSck(String(input.sck ?? ''));
    const ownerPhone = digits(input.phone ?? '');
    const ownerEmail = normalizeEmail(input.email ?? '');
    const offerId = String(input.offerId ?? '').trim();

    const positive = eventType === 'purchase_approved' || eventType === 'subscription_renewed';
    const revoke = eventType === 'refund' || eventType === 'chargeback';
    const cancel = eventType === 'subscription_canceled';
    const renewalRefused = eventType === 'subscription_renewal_refused';
    if (!positive && !revoke && !cancel && !renewalRefused) return { ignored: true };

    const identity = orderId || subscriptionId;
    if (!identity) throw new Error('CASH_CAKTO_EVENT_ID_INVALID');

    // purchase_approved e subscription_renewed da mesma cobrança compartilham a
    // mesma chave para nunca somar o mesmo período duas vezes.
    const eventKey = positive
      ? `cakto:payment:${identity}`
      : `cakto:${eventType}:${identity}`;

    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [eventKey]);

      const seen = await client.query(`select 1 from cash_payment_events where id=$1 limit 1`, [eventKey]);
      if (seen.rowCount) {
        await client.query('commit');
        return { duplicate: true };
      }

      const account = await findAccount(client, { companyId, phone: ownerPhone, email: ownerEmail });
      if (!account) throw new Error('CASH_PAYMENT_ACCOUNT_NOT_FOUND');

      const planKey = resolveCaktoPlan({
        offerId,
        offerName: input.offerName ?? '',
        productName: input.productName ?? '',
        amountCents: input.amountCents,
        currentPlan: account.plan_key
      });

      let periodEnd: Date | null = account.subscription_current_period_end
        ? new Date(account.subscription_current_period_end)
        : null;

      if (positive) {
        if (!planKey) throw new Error('CASH_PLAN_INVALID');
        const now = new Date();
        const nextPayment = planKey === 'cash_monthly'
          ? validFutureDate(input.nextPaymentDate)
          : null;

        if (nextPayment) {
          periodEnd = periodEnd && periodEnd.getTime() > nextPayment.getTime()
            ? periodEnd
            : nextPayment;
        } else {
          const base = periodEnd && periodEnd.getTime() > now.getTime() ? periodEnd : now;
          periodEnd = addMonths(base, planMonths(planKey));
        }

        await client.query(
          `update companies set
             subscription_status='active',access_active=true,plan_key=$2,
             subscription_started_at=coalesce(subscription_started_at,now()),
             subscription_current_period_end=$3,cancel_at_period_end=false,updated_at=now()
           where id=$1`,
          [account.id, planKey, periodEnd]
        );
      } else if (revoke) {
        periodEnd = new Date();
        await client.query(
          `update companies set
             subscription_status='canceled',access_active=false,
             subscription_current_period_end=$2,cancel_at_period_end=false,updated_at=now()
           where id=$1`,
          [account.id, periodEnd]
        );
      } else if (cancel) {
        await client.query(
          `update companies set cancel_at_period_end=true,updated_at=now() where id=$1`,
          [account.id]
        );
      }

      await saveEvent(client, {
        id: eventKey,
        eventType,
        orderId,
        company: account,
        ownerPhone,
        ownerEmail,
        planKey,
        offerId,
        subscriptionId,
        amountCents: Number.isInteger(input.amountCents) ? input.amountCents! : null,
        payload: input.payload ?? {}
      });

      await client.query('commit');
      return {
        companyId: account.id,
        ownerPhone: digits(account.owner_phone ?? ownerPhone) || null,
        ownerEmail: normalizeEmail(account.owner_email ?? ownerEmail) || null,
        planKey,
        periodEnd,
        activated: positive,
        revoked: revoke,
        canceledAtPeriodEnd: cancel,
        renewalRefused
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}

export const caktoPaymentService = new CaktoPaymentService();
