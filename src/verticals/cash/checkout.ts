import { randomBytes } from 'node:crypto';
import { db } from '../../infrastructure/db.js';
import { redis } from '../../infrastructure/redis.js';
import { env } from '../../config/env.js';

export type CashPlanKey = 'cash_monthly' | 'cash_quarterly' | 'cash_annual';

type CashCheckoutProfile = {
  owner_name: string | null;
  owner_email: string | null;
  owner_phone: string | null;
};

const ALIAS_TTL_SECONDS = 48 * 60 * 60;
const ALIAS_PREFIX = 'arles:cash:payment-alias:';

function digits(value: string): string {
  return String(value ?? '').replace(/\D/g, '');
}

function checkoutPhone(value: string): string {
  const phone = digits(value);
  if (!phone) return '';
  if (phone.startsWith('55')) return phone;
  return phone.length >= 10 && phone.length <= 11 ? `55${phone}` : phone;
}

function planSlug(plan: CashPlanKey): 'monthly' | 'quarterly' | 'annual' {
  if (plan === 'cash_monthly') return 'monthly';
  if (plan === 'cash_quarterly') return 'quarterly';
  return 'annual';
}

export function buildCaktoCheckoutUrl(input: {
  baseUrl: string;
  companyId: string;
  plan: CashPlanKey;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}): string {
  const baseUrl = String(input.baseUrl ?? '').trim();
  if (!baseUrl) return '';

  try {
    const url = new URL(baseUrl);
    const name = String(input.name ?? '').trim();
    const email = String(input.email ?? '').trim().toLowerCase();
    const phone = checkoutPhone(String(input.phone ?? ''));

    if (name) url.searchParams.set('name', name);
    if (email) {
      url.searchParams.set('email', email);
      url.searchParams.set('confirmEmail', email);
    }
    if (phone) url.searchParams.set('phone', phone);

    // sck identifica tanto a conta quanto o plano que originou o checkout.
    // Isso evita depender apenas de nome/preço da oferta no webhook.
    url.searchParams.set('sck', `arlescash:${input.companyId}:${planSlug(input.plan)}`);
    url.searchParams.set('src', 'arles_cash_whatsapp');
    return url.toString();
  } catch {
    return baseUrl;
  }
}

async function profile(companyId: string): Promise<CashCheckoutProfile> {
  const result = await db.query<CashCheckoutProfile>(
    `select owner_name,owner_email,owner_phone
     from cash_settings
     where company_id=$1
     limit 1`,
    [companyId]
  );
  return result.rows[0] ?? { owner_name: null, owner_email: null, owner_phone: null };
}

function baseUrlForPlan(plan: CashPlanKey): string {
  if (plan === 'cash_monthly') return env.cashPaymentMonthlyUrl;
  if (plan === 'cash_quarterly') return env.cashPaymentQuarterlyUrl;
  return env.cashPaymentAnnualUrl;
}

export async function directCashCheckoutUrl(companyId: string, plan: CashPlanKey): Promise<string> {
  const owner = await profile(companyId);
  return buildCaktoCheckoutUrl({
    baseUrl: baseUrlForPlan(plan),
    companyId,
    plan,
    name: owner.owner_name,
    email: owner.owner_email,
    phone: owner.owner_phone
  });
}

async function paymentAlias(companyId: string, plan: CashPlanKey): Promise<string> {
  const direct = await directCashCheckoutUrl(companyId, plan);
  if (!direct) return '';

  const publicBase = env.cashPaymentPublicBaseUrl || env.publicBaseUrl;
  if (!publicBase) return direct;

  const token = randomBytes(10).toString('base64url');
  await redis.set(
    `${ALIAS_PREFIX}${token}`,
    JSON.stringify({ companyId, plan }),
    'EX',
    ALIAS_TTL_SECONDS
  );
  return `${publicBase}/cash/p/${token}`;
}

export async function resolveCashPaymentAlias(token: string): Promise<string | null> {
  const value = await redis.get(`${ALIAS_PREFIX}${String(token ?? '').trim()}`);
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as { companyId?: string; plan?: CashPlanKey };
    if (!parsed.companyId) return null;
    if (parsed.plan !== 'cash_monthly' && parsed.plan !== 'cash_quarterly' && parsed.plan !== 'cash_annual') {
      return null;
    }
    return await directCashCheckoutUrl(parsed.companyId, parsed.plan);
  } catch {
    return null;
  }
}

export async function cashCheckoutLinks(companyId: string) {
  const [monthly, quarterly, annual] = await Promise.all([
    paymentAlias(companyId, 'cash_monthly'),
    paymentAlias(companyId, 'cash_quarterly'),
    paymentAlias(companyId, 'cash_annual')
  ]);
  return { monthly, quarterly, annual };
}

export async function cashPaymentMenuForCompany(companyId: string): Promise<string> {
  const links = await cashCheckoutLinks(companyId);
  return [
    '📌 Mensal: R$5,00/mês' + (links.monthly ? `\n👉 ${links.monthly}` : ''),
    '📌 Trimestral: R$13,50 (= R$4,50/mês)' + (links.quarterly ? `\n👉 ${links.quarterly}` : ''),
    '🏆 Anual — Mais popular: R$39,90 (= R$3,33/mês)' + (links.annual ? `\n👉 ${links.annual}` : '')
  ].join('\n\n');
}