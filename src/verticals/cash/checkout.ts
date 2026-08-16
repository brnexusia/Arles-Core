import { db } from '../../infrastructure/db.js';
import { env } from '../../config/env.js';

export type CashPlanKey = 'cash_monthly' | 'cash_semiannual' | 'cash_annual';

type CashCheckoutProfile = {
  owner_name: string | null;
  owner_email: string | null;
  owner_phone: string | null;
};

function digits(value: string): string {
  return String(value ?? '').replace(/\D/g, '');
}

function checkoutPhone(value: string): string {
  const phone = digits(value);
  if (!phone) return '';
  if (phone.startsWith('55')) return phone;
  return phone.length >= 10 && phone.length <= 11 ? `55${phone}` : phone;
}

export function buildCaktoCheckoutUrl(input: {
  baseUrl: string;
  companyId: string;
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

    // sck é o identificador interno da conta. Mesmo que o comprador edite os
    // campos visíveis do checkout, esse valor permite conciliar o webhook com
    // a conta Cash que originou o pagamento.
    url.searchParams.set('sck', `arlescash:${input.companyId}`);
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

export async function cashCheckoutLinks(companyId: string) {
  const owner = await profile(companyId);
  const make = (baseUrl: string) => buildCaktoCheckoutUrl({
    baseUrl,
    companyId,
    name: owner.owner_name,
    email: owner.owner_email,
    phone: owner.owner_phone
  });

  return {
    monthly: make(env.cashPaymentMonthlyUrl),
    semiannual: make(env.cashPaymentSemiannualUrl),
    annual: make(env.cashPaymentAnnualUrl)
  };
}

export async function cashPaymentMenuForCompany(companyId: string): Promise<string> {
  const links = await cashCheckoutLinks(companyId);
  return [
    '📌 Mensal: R$4,99/mês' + (links.monthly ? `\n👉 ${links.monthly}` : ''),
    '📌 Semestral: R$24,90 (= R$4,15/mês)' + (links.semiannual ? `\n👉 ${links.semiannual}` : ''),
    '🏆 Anual — Mais popular: R$39,90 (= R$3,33/mês — 2 meses grátis 🎁)' + (links.annual ? `\n👉 ${links.annual}` : '')
  ].join('\n\n');
}
