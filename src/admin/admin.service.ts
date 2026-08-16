import { db } from '../infrastructure/db.js';

type SummaryRow = {
  companies: string;
  users: string;
  active_subscriptions: string;
  trials: string;
  past_due: string;
  new_companies_30d: string;
  trials_ending_3d: string;
  monthly_revenue_cents: string;
  revenue_received_30d_cents: string;
  contacts_used: string;
};

type CompanyRow = {
  id: string;
  name: string;
  owner_name: string | null;
  owner_email: string | null;
  owner_phone: string | null;
  verticals: string[] | null;
  plan_key: string | null;
  subscription_status: string;
  monthly_price_cents: number | null;
  monthly_contact_limit: number | null;
  monthly_contacts_used: number;
  trial_ends_at: Date | null;
  subscription_current_period_end: Date | null;
  whatsapp_status: string | null;
  created_at: Date;
};

type CashMetricRow = {
  users: number | string;
  active_subscriptions: number | string;
  trials: number | string;
  expired: number | string;
  trials_ending_3d: number | string;
  lifetime_users: number | string;
  monthly_revenue_cents: number | string;
  revenue_received_30d_cents: number | string;
  records_today: number | string;
  records_30d: number | string;
  active_users_today: number | string;
};

type CashUserRow = {
  id: string;
  owner_name: string | null;
  owner_email: string | null;
  owner_phone: string | null;
  plan_key: string | null;
  subscription_status: string;
  monthly_price_cents: number | null;
  trial_ends_at: Date | null;
  subscription_current_period_end: Date | null;
  created_at: Date;
  records_today: number | string;
  records_total: number | string;
  last_record_at: Date | null;
};

function iso(value: Date | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

function normalizedEmail(value: unknown): string {
  const email = String(value ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('ADMIN_EMAIL_INVALID');
  return email;
}

function normalizedPhone(value: unknown): string {
  const phone = String(value ?? '').replace(/\D/g, '').slice(0, 20);
  if (phone.length < 10) throw new Error('ADMIN_PHONE_INVALID');
  return phone;
}

function adminDate(value: unknown): string | null {
  if (value == null || value === '') return null;
  const date = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('ADMIN_DATE_INVALID');
  return date;
}

const allowedStatus = new Set(['trial', 'active', 'expired', 'past_due']);

export class AdminService {
  async overview() {
    const [summaryResult, companiesResult] = await Promise.all([
      db.query<SummaryRow>(`
        select
          count(*)::text as companies,
          (select count(*) from auth_users where role = 'user')::text as users,
          count(*) filter (where subscription_status = 'active')::text as active_subscriptions,
          count(*) filter (
            where subscription_status = 'trial'
              and trial_ends_at is not null
              and trial_ends_at > now()
          )::text as trials,
          count(*) filter (where subscription_status = 'past_due')::text as past_due,
          count(*) filter (where created_at >= now() - interval '30 days')::text as new_companies_30d,
          count(*) filter (
            where subscription_status = 'trial'
              and trial_ends_at between now() and now() + interval '3 days'
          )::text as trials_ending_3d,
          coalesce(sum(monthly_price_cents) filter (
            where subscription_status = 'active'
          ), 0)::text as monthly_revenue_cents,
          (select coalesce(sum(amount_paid_cents), 0)
           from billing_payments
           where paid_at >= now() - interval '30 days')::text as revenue_received_30d_cents,
          coalesce(sum(monthly_contacts_used), 0)::text as contacts_used
        from companies
      `),
      db.query<CompanyRow>(`
        select
          c.id::text,
          c.name,
          u.name as owner_name,
          u.email as owner_email,
          u.phone as owner_phone,
          coalesce((
            select array_agg(cv.vertical_id order by cv.vertical_id)
            from company_verticals cv
            where cv.company_id = c.id and cv.enabled = true
          ), array[]::text[]) as verticals,
          c.plan_key,
          c.subscription_status,
          c.monthly_price_cents,
          c.monthly_contact_limit,
          c.monthly_contacts_used,
          c.trial_ends_at,
          c.subscription_current_period_end,
          case when coalesce(c.active_vertical_id,c.vertical)='cash' then 'managed' else wc.status end as whatsapp_status,
          c.created_at
        from companies c
        left join auth_users u on u.company_id = c.id and u.role = 'user'
        left join whatsapp_connections wc on wc.company_id = c.id
        order by c.created_at desc
      `)
    ]);

    const summary = summaryResult.rows[0];
    if (!summary) throw new Error('ADMIN_OVERVIEW_UNAVAILABLE');

    return {
      generatedAt: new Date().toISOString(),
      metrics: {
        companies: Number(summary.companies),
        users: Number(summary.users),
        activeSubscriptions: Number(summary.active_subscriptions),
        trials: Number(summary.trials),
        pastDue: Number(summary.past_due),
        newCompanies30d: Number(summary.new_companies_30d),
        trialsEnding3d: Number(summary.trials_ending_3d),
        monthlyRevenueCents: Number(summary.monthly_revenue_cents),
        revenueReceived30dCents: Number(summary.revenue_received_30d_cents),
        contactsUsed: Number(summary.contacts_used)
      },
      companies: companiesResult.rows.map(row => ({
        id: row.id,
        name: row.name,
        ownerName: row.owner_name,
        ownerEmail: row.owner_email,
        ownerPhone: row.owner_phone,
        verticals: row.verticals ?? [],
        planKey: row.plan_key,
        subscriptionStatus: row.subscription_status,
        monthlyPriceCents: row.monthly_price_cents,
        monthlyContactLimit: row.monthly_contact_limit,
        monthlyContactsUsed: Number(row.monthly_contacts_used ?? 0),
        trialEndsAt: iso(row.trial_ends_at),
        subscriptionEndsAt: iso(row.subscription_current_period_end),
        whatsappStatus: row.whatsapp_status ?? 'disconnected',
        createdAt: iso(row.created_at)
      }))
    };
  }

  async cashOverview() {
    const [metricsResult, usersResult] = await Promise.all([
      db.query<CashMetricRow>(`
        with cash_companies as (
          select distinct c.*
          from companies c
          left join company_verticals cv
            on cv.company_id = c.id
           and cv.vertical_id = 'cash'
           and cv.enabled = true
          where coalesce(c.active_vertical_id, c.vertical) = 'cash'
             or cv.company_id is not null
        ), usage as (
          select
            count(*) filter (where transaction_date = current_date)::int as records_today,
            count(*) filter (where transaction_date >= current_date - 29)::int as records_30d,
            count(distinct company_id) filter (where transaction_date = current_date)::int as active_users_today
          from cash_transactions
        )
        select
          count(*)::int as users,
          count(*) filter (where c.subscription_status = 'active')::int as active_subscriptions,
          count(*) filter (
            where c.subscription_status = 'trial'
              and c.trial_ends_at > now()
          )::int as trials,
          count(*) filter (where c.subscription_status = 'expired')::int as expired,
          count(*) filter (
            where c.subscription_status = 'trial'
              and c.trial_ends_at between now() and now() + interval '3 days'
          )::int as trials_ending_3d,
          count(*) filter (
            where c.subscription_status = 'active'
              and c.subscription_current_period_end is null
          )::int as lifetime_users,
          coalesce(sum(c.monthly_price_cents) filter (
            where c.subscription_status = 'active'
          ), 0)::int as monthly_revenue_cents,
          (select coalesce(sum(bp.amount_paid_cents), 0)::int
           from billing_payments bp
           join cash_companies cc on cc.id = bp.company_id
           where bp.paid_at >= now() - interval '30 days') as revenue_received_30d_cents,
          coalesce((select records_today from usage), 0)::int as records_today,
          coalesce((select records_30d from usage), 0)::int as records_30d,
          coalesce((select active_users_today from usage), 0)::int as active_users_today
        from cash_companies c
      `),
      db.query<CashUserRow>(`
        with cash_companies as (
          select distinct c.*
          from companies c
          left join company_verticals cv
            on cv.company_id = c.id
           and cv.vertical_id = 'cash'
           and cv.enabled = true
          where coalesce(c.active_vertical_id, c.vertical) = 'cash'
             or cv.company_id is not null
        ), usage as (
          select
            company_id,
            count(*)::int as records_total,
            count(*) filter (where transaction_date = current_date)::int as records_today,
            max(created_at) as last_record_at
          from cash_transactions
          group by company_id
        )
        select
          c.id::text,
          coalesce(nullif(cs.owner_name, ''), nullif(u.name, ''), c.name) as owner_name,
          u.email as owner_email,
          coalesce(nullif(cs.owner_phone, ''), u.phone) as owner_phone,
          c.plan_key,
          c.subscription_status,
          c.monthly_price_cents,
          c.trial_ends_at,
          c.subscription_current_period_end,
          c.created_at,
          coalesce(x.records_today, 0)::int as records_today,
          coalesce(x.records_total, 0)::int as records_total,
          x.last_record_at
        from cash_companies c
        left join auth_users u on u.company_id = c.id and u.role = 'user'
        left join cash_settings cs on cs.company_id = c.id
        left join usage x on x.company_id = c.id
        order by c.created_at desc
      `)
    ]);

    const metrics = metricsResult.rows[0];
    if (!metrics) throw new Error('ADMIN_CASH_UNAVAILABLE');

    return {
      generatedAt: new Date().toISOString(),
      cashMetrics: {
        users: Number(metrics.users ?? 0),
        activeSubscriptions: Number(metrics.active_subscriptions ?? 0),
        trials: Number(metrics.trials ?? 0),
        expired: Number(metrics.expired ?? 0),
        trialsEnding3d: Number(metrics.trials_ending_3d ?? 0),
        lifetimeUsers: Number(metrics.lifetime_users ?? 0),
        monthlyRevenueCents: Number(metrics.monthly_revenue_cents ?? 0),
        revenueReceived30dCents: Number(metrics.revenue_received_30d_cents ?? 0),
        recordsToday: Number(metrics.records_today ?? 0),
        records30d: Number(metrics.records_30d ?? 0),
        activeUsersToday: Number(metrics.active_users_today ?? 0)
      },
      cashUsers: usersResult.rows.map(row => ({
        id: row.id,
        ownerName: row.owner_name,
        ownerEmail: row.owner_email,
        ownerPhone: row.owner_phone,
        planKey: row.plan_key,
        subscriptionStatus: row.subscription_status,
        monthlyPriceCents: row.monthly_price_cents,
        lifetimeAccess:
          row.subscription_status === 'active' && row.subscription_current_period_end == null,
        trialEndsAt: iso(row.trial_ends_at),
        subscriptionEndsAt: iso(row.subscription_current_period_end),
        recordsToday: Number(row.records_today ?? 0),
        recordsTotal: Number(row.records_total ?? 0),
        lastRecordAt: iso(row.last_record_at),
        createdAt: iso(row.created_at)
      }))
    };
  }

  async updateCashUser(companyId: string, body: Record<string, unknown>) {
    const client = await db.connect();
    try {
      await client.query('begin');

      const exists = await client.query(
        `select c.id
         from companies c
         left join company_verticals cv
           on cv.company_id = c.id
          and cv.vertical_id = 'cash'
          and cv.enabled = true
         where c.id = $1
           and (
             coalesce(c.active_vertical_id, c.vertical) = 'cash'
             or cv.company_id is not null
           )
         limit 1`,
        [companyId]
      );
      if (!exists.rowCount) throw new Error('ADMIN_USER_NOT_FOUND');

      const name = String(body.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
      const email = normalizedEmail(body.email);
      const phone = normalizedPhone(body.phone);
      const status = String(body.subscriptionStatus ?? 'expired');
      if (!allowedStatus.has(status)) throw new Error('ADMIN_STATUS_INVALID');

      const lifetime = body.lifetimeAccess === true;
      const trialEndsAt = adminDate(body.trialEndsAt);
      const subscriptionEndsAt = adminDate(body.subscriptionEndsAt);

      const emailDuplicate = await client.query(
        `select 1
         from auth_users
         where email_normalized = $1
           and company_id <> $2
         limit 1`,
        [email, companyId]
      );
      if (emailDuplicate.rowCount) throw new Error('ADMIN_EMAIL_IN_USE');

      const phoneDuplicate = await client.query(
        `select 1
         from cash_settings
         where company_id <> $1
           and right(regexp_replace(coalesce(owner_phone, ''), '[^0-9]', '', 'g'), 11)
               = right($2, 11)
         limit 1`,
        [companyId, phone]
      );
      if (phoneDuplicate.rowCount) throw new Error('ADMIN_PHONE_IN_USE');

      await client.query(
        `update auth_users
         set name = $2,
             email = $3,
             email_normalized = $3,
             phone = $4,
             updated_at = now()
         where company_id = $1 and role = 'user'`,
        [companyId, name, email, phone]
      );

      await client.query(
        `insert into cash_settings(company_id, owner_phone, owner_name)
         values($1, $2, $3)
         on conflict(company_id) do update set
           owner_phone = excluded.owner_phone,
           owner_name = excluded.owner_name,
           updated_at = now()`,
        [companyId, phone, name]
      );

      if (lifetime) {
        await client.query(
          `update companies set
             subscription_status = 'active',
             access_active = true,
             subscription_current_period_end = null,
             trial_ends_at = null,
             plan_key = coalesce(plan_key, 'cash_monthly'),
             updated_at = now()
           where id = $1`,
          [companyId]
        );
      } else if (status === 'trial') {
        await client.query(
          `update companies set
             subscription_status = 'trial',
             access_active = true,
             trial_ends_at = coalesce($2::date + interval '1 day', now() + interval '7 days'),
             subscription_current_period_end = null,
             updated_at = now()
           where id = $1`,
          [companyId, trialEndsAt]
        );
      } else if (status === 'active') {
        await client.query(
          `update companies set
             subscription_status = 'active',
             access_active = true,
             trial_ends_at = null,
             subscription_current_period_end = coalesce($2::date + interval '1 day', now() + interval '1 month'),
             plan_key = coalesce(plan_key, 'cash_monthly'),
             updated_at = now()
           where id = $1`,
          [companyId, subscriptionEndsAt]
        );
      } else {
        await client.query(
          `update companies set
             subscription_status = $2,
             access_active = false,
             updated_at = now()
           where id = $1`,
          [companyId, status]
        );
      }

      await client.query('commit');
      return { ok: true, companyId };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async expireCashUser(companyId: string) {
    const result = await db.query(
      `update companies c
       set subscription_status = 'expired',
           access_active = false,
           updated_at = now()
       where c.id = $1
         and (
           coalesce(c.active_vertical_id, c.vertical) = 'cash'
           or exists(
             select 1
             from company_verticals cv
             where cv.company_id = c.id
               and cv.vertical_id = 'cash'
               and cv.enabled = true
           )
         )
       returning c.id::text`,
      [companyId]
    );
    if (!result.rowCount) throw new Error('ADMIN_USER_NOT_FOUND');
    return { ok: true, companyId };
  }
}

export const adminService = new AdminService();
