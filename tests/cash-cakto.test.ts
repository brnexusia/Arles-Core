import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';
process.env.CASH_CAKTO_MONTHLY_OFFER_ID = 'offer-month';
process.env.CASH_CAKTO_QUARTERLY_OFFER_ID = 'offer-quarter';
process.env.CASH_CAKTO_ANNUAL_OFFER_ID = 'offer-year';

const { buildCaktoCheckoutUrl } = await import('../src/verticals/cash/checkout.js');
const { companyIdFromSck, parseCaktoSck, resolveCaktoPlan } = await import('../src/verticals/cash/cakto-payment.js');

describe('cash Cakto integration', () => {
  it('personaliza checkout com identidade e plano da conta', () => {
    const companyId = '123e4567-e89b-42d3-a456-426614174000';
    const result = buildCaktoCheckoutUrl({
      baseUrl: 'https://pay.cakto.com.br/ABC123?utm_source=lp',
      companyId,
      plan: 'cash_quarterly',
      name: 'Felipe Gloria',
      email: 'Felipe@Example.com',
      phone: '75999622157'
    });
    const url = new URL(result);

    expect(url.searchParams.get('name')).toBe('Felipe Gloria');
    expect(url.searchParams.get('email')).toBe('felipe@example.com');
    expect(url.searchParams.get('confirmEmail')).toBe('felipe@example.com');
    expect(url.searchParams.get('phone')).toBe('5575999622157');
    expect(url.searchParams.get('sck')).toBe(`arlescash:${companyId}:quarterly`);
    expect(url.searchParams.get('src')).toBe('arles_cash_whatsapp');
    expect(url.searchParams.get('utm_source')).toBe('lp');
  });

  it('recupera conta e plano do sck esperado', () => {
    const companyId = '123e4567-e89b-42d3-a456-426614174000';
    expect(companyIdFromSck(`arlescash:${companyId}:monthly`)).toBe(companyId);
    expect(parseCaktoSck(`arlescash:${companyId}:quarterly`)).toEqual({
      companyId,
      planKey: 'cash_quarterly'
    });
    expect(companyIdFromSck('outro:123')).toBeNull();
    expect(companyIdFromSck('arlescash:qualquer-coisa')).toBeNull();
  });

  it('mapeia plano primeiro pelo sck e depois pelo id da oferta Cakto', () => {
    expect(resolveCaktoPlan({ sckPlan: 'cash_quarterly', offerId: 'qualquer' })).toBe('cash_quarterly');
    expect(resolveCaktoPlan({ offerId: 'offer-month' })).toBe('cash_monthly');
    expect(resolveCaktoPlan({ offerId: 'offer-quarter' })).toBe('cash_quarterly');
    expect(resolveCaktoPlan({ offerId: 'offer-year' })).toBe('cash_annual');
  });

  it('mantem fallback por nome e valor para compras sem sck', () => {
    expect(resolveCaktoPlan({ offerName: 'Arles Cash Anual' })).toBe('cash_annual');
    expect(resolveCaktoPlan({ productName: 'Plano Trimestral' })).toBe('cash_quarterly');
    expect(resolveCaktoPlan({ amountCents: 500 })).toBe('cash_monthly');
    expect(resolveCaktoPlan({ amountCents: 1350 })).toBe('cash_quarterly');
    expect(resolveCaktoPlan({ amountCents: 3990 })).toBe('cash_annual');
  });
});