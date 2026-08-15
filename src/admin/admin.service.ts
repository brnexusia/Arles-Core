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

function iso(value: Date | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

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
}

export const adminService = new AdminService();
