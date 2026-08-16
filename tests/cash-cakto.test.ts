import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';
process.env.CASH_CAKTO_MONTHLY_OFFER_ID = 'offer-month';
process.env.CASH_CAKTO_SEMIANNUAL_OFFER_ID = 'offer-semester';
process.env.CASH_CAKTO_ANNUAL_OFFER_ID = 'offer-year';

const { buildCaktoCheckoutUrl } = await import('../src/verticals/cash/checkout.js');
const { companyIdFromSck, resolveCaktoPlan } = await import('../src/verticals/cash/cakto-payment.js');

describe('cash Cakto integration', () => {
  it('personaliza checkout com identidade da conta sem criar credencial compartilhavel', () => {
    const companyId = '123e4567-e89b-42d3-a456-426614174000';
    const result = buildCaktoCheckoutUrl({
      baseUrl: 'https://pay.cakto.com.br/ABC123?utm_source=lp',
      companyId,
      name: 'Felipe Gloria',
      email: 'Felipe@Example.com',
      phone: '75999622157'
    });
    const url = new URL(result);

    expect(url.searchParams.get('name')).toBe('Felipe Gloria');
    expect(url.searchParams.get('email')).toBe('felipe@example.com');
    expect(url.searchParams.get('confirmEmail')).toBe('felipe@example.com');
    expect(url.searchParams.get('phone')).toBe('5575999622157');
    expect(url.searchParams.get('sck')).toBe(`arlescash:${companyId}`);
    expect(url.searchParams.get('src')).toBe('arles_cash_whatsapp');
    expect(url.searchParams.get('utm_source')).toBe('lp');
  });

  it('recupera o company id apenas do sck no formato esperado', () => {
    const companyId = '123e4567-e89b-42d3-a456-426614174000';
    expect(companyIdFromSck(`arlescash:${companyId}`)).toBe(companyId);
    expect(companyIdFromSck('outro:123')).toBeNull();
    expect(companyIdFromSck('arlescash:qualquer-coisa')).toBeNull();
  });

  it('mapeia plano primeiro pelo id da oferta Cakto', () => {
    expect(resolveCaktoPlan({ offerId: 'offer-month' })).toBe('cash_monthly');
    expect(resolveCaktoPlan({ offerId: 'offer-semester' })).toBe('cash_semiannual');
    expect(resolveCaktoPlan({ offerId: 'offer-year' })).toBe('cash_annual');
  });

  it('mantem fallback por nome e valor apenas para facilitar a implantacao', () => {
    expect(resolveCaktoPlan({ offerName: 'Arles Cash Anual' })).toBe('cash_annual');
    expect(resolveCaktoPlan({ productName: 'Plano Semestral' })).toBe('cash_semiannual');
    expect(resolveCaktoPlan({ amountCents: 500 })).toBe('cash_monthly');
    expect(resolveCaktoPlan({ amountCents: 2490 })).toBe('cash_semiannual');
    expect(resolveCaktoPlan({ amountCents: 3990 })).toBe('cash_annual');
  });
});
