import { db } from '../infrastructure/db.js';

export type BillingStatus =
  | 'trial'
  | 'active'
  | 'expired'
  | 'past_due'
  | 'canceled';

function stripeToArlesStatus(eventType: string, stripeStatus: string): BillingStatus | null {
  if (eventType === 'customer.subscription.deleted') return 'canceled';
  if (eventType === 'invoice.payment_failed') return 'past_due';
  if (eventType === 'invoice.paid') return 'active';

  if (stripeStatus === 'active' || stripeStatus === 'trialing') return 'active';
  if (stripeStatus === 'past_due' || stripeStatus === 'unpaid' || stripeStatus === 'incomplete') return 'past_due';
  if (stripeStatus === 'canceled') return 'canceled';
  if (stripeStatus === 'incomplete_expired' || stripeStatus === 'paused') return 'expired';
  return null;
}

export class BillingService {
  async catalog() {
    const result = await db.query(
      `select plan_key,display_name,display_price_cents,currency,
              contact_limit,sort_order,configuration
       from billing_plan_catalog
       where active=true
       order by sort_order,plan_key`
    );
    return result.rows;
  }

  async subscriptionInfo(companyId: string) {
    const result = await db.query<any>(
      `select
         subscription_status,
         trial_ends_at,
         subscription_current_period_end,
         stripe_customer_id,
         stripe_subscription_id,
         cancel_at_period_end,
         plan_key,
         monthly_contact_limit,
         monthly_contacts_used
       from companies
       where id=$1
       limit 1`,
      [companyId]
    );
    const row = result.rows[0];
    if (!row) throw new Error('COMPANY_NOT_FOUND');

    const now = Date.now();
    const storedStatus = String(row.subscription_status || 'expired') as BillingStatus;
    const trialEndsAt = row.trial_ends_at ? new Date(row.trial_ends_at) : null;
    const subscriptionEndsAt = row.subscription_current_period_end
      ? new Date(row.subscription_current_period_end)
      : null;
    const cancelAtPeriodEnd = row.cancel_at_period_end === true;

    const trialExpired =
      storedStatus === 'trial' &&
      !!trialEndsAt &&
      trialEndsAt.getTime() <= now;

    const status: BillingStatus = trialExpired ? 'expired' : storedStatus;

    const isTrialActive =
      status === 'trial' &&
      !!trialEndsAt &&
      trialEndsAt.getTime() > now;

    const isSubActive =
      status === 'active' &&
      (!cancelAtPeriodEnd ||
        !subscriptionEndsAt ||
        subscriptionEndsAt.getTime() > now);

    let daysRemaining: number | null = null;
    if (storedStatus === 'trial' && trialEndsAt) {
      daysRemaining = Math.max(
        0,
        Math.ceil((trialEndsAt.getTime() - now) / 86_400_000)
      );
    }

    return {
      status,
      trialEndsAt: trialEndsAt?.toISOString() ?? null,
      subscriptionEndsAt: subscriptionEndsAt?.toISOString() ?? null,
      daysRemaining,
      hasAccess: isTrialActive || isSubActive,
      isExpired: status === 'expired',
      isTrialExpiring:
        status === 'trial' &&
        daysRemaining !== null &&
        daysRemaining > 0 &&
        daysRemaining <= 2,
      planKey: row.plan_key ?? null,
      contactLimit: row.monthly_contact_limit ?? null,
      contactsUsed: Number(row.monthly_contacts_used ?? 0),
      stripeCustomerId: row.stripe_customer_id ?? null,
      stripeSubscriptionId: row.stripe_subscription_id ?? null,
      cancelAtPeriodEnd
    };
  }

  async context(companyId: string) {
    const result = await db.query<any>(
      `select
         c.id::text as company_id,
         c.name,
         c.subscription_status,
         c.stripe_customer_id,
         c.stripe_subscription_id,
         c.plan_key,
         u.email
       from companies c
       left join auth_users u on u.company_id = c.id and u.role='user'
       where c.id=$1
       limit 1`,
      [companyId]
    );
    const row = result.rows[0];
    if (!row) throw new Error('COMPANY_NOT_FOUND');
    return row;
  }

  async setStripeCustomer(companyId: string, customerId: string): Promise<void> {
    await db.query(
      `update companies
       set stripe_customer_id=$2,updated_at=now()
       where id=$1`,
      [companyId, customerId]
    );
  }

  async applyStripeEvent(body: any): Promise<{ duplicate?: boolean; companyId?: string }> {
    const eventId = String(body.event_id ?? body.id ?? '').trim();
    const eventType = String(body.event_type ?? body.type ?? '').trim();
    if (!eventId || !eventType) throw new Error('STRIPE_EVENT_INVALID');

    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [eventId]);

      const seen = await client.query(
        `select 1 from stripe_events where id=$1 limit 1`,
        [eventId]
      );
      if (seen.rowCount) {
        await client.query('commit');
        return { duplicate: true };
      }

      const companyIdInput = String(body.company_id ?? '').trim() || null;
      const subscriptionId = String(body.subscription_id ?? '').trim() || null;
      const customerId = String(body.customer_id ?? '').trim() || null;

      const found = await client.query<{ id: string }>(
        `select id::text
         from companies
         where ($1::uuid is not null and id=$1::uuid)
            or ($2::text is not null and stripe_subscription_id=$2)
            or ($3::text is not null and stripe_customer_id=$3)
         order by case when $1::uuid is not null and id=$1::uuid then 0 else 1 end
         limit 1`,
        [companyIdInput, subscriptionId, customerId]
      );

      const companyId = found.rows[0]?.id;
      if (!companyId) throw new Error('STRIPE_COMPANY_NOT_FOUND');

      const stripeStatus = String(body.stripe_status ?? '').toLowerCase();
      const nextStatus = stripeToArlesStatus(eventType, stripeStatus);
      const planKey = String(body.plan_key ?? '').trim() || null;
      const catalogPlan = planKey
        ? await client.query<{ contact_limit: number }>(
          `select contact_limit from billing_plan_catalog where plan_key=$1 and active=true limit 1`,
          [planKey]
        )
        : null;
      if (planKey && !catalogPlan?.rows[0]) throw new Error('BILLING_PLAN_INVALID');
      const limit = catalogPlan?.rows[0]?.contact_limit ?? null;

      const currentPeriodEnd = body.current_period_end
        ? new Date(body.current_period_end).toISOString()
        : null;
      const startedAt = body.start_date
        ? new Date(body.start_date).toISOString()
        : null;

      await client.query(
        `update companies set
           stripe_customer_id=coalesce($2,stripe_customer_id),
           stripe_subscription_id=coalesce($3,stripe_subscription_id),
           stripe_price_id=coalesce($4,stripe_price_id),
           subscription_status=coalesce($5,subscription_status),
           access_active=case
             when coalesce($5,subscription_status)='active' then true
             when coalesce($5,subscription_status)='trial'
               and trial_ends_at is not null and trial_ends_at > now() then true
             else false
           end,
           subscription_started_at=coalesce($6::timestamptz,subscription_started_at),
           subscription_current_period_end=coalesce($7::timestamptz,subscription_current_period_end),
           cancel_at_period_end=coalesce($8,cancel_at_period_end),
           plan_key=coalesce($9,plan_key),
           monthly_contact_limit=coalesce($10,monthly_contact_limit),
           updated_at=now()
         where id=$1`,
        [
          companyId,
          customerId,
          subscriptionId,
          String(body.price_id ?? '').trim() || null,
          nextStatus,
          startedAt,
          currentPeriodEnd,
          typeof body.cancel_at_period_end === 'boolean'
            ? body.cancel_at_period_end
            : null,
          planKey,
          limit
        ]
      );

      await client.query(
        `insert into stripe_events(id,type) values($1,$2)`,
        [eventId, eventType]
      );

      await client.query('commit');
      return { companyId };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}

export const billingService = new BillingService();
