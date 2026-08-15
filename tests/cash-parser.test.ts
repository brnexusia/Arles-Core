import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const { deterministicCashParse } = await import('../src/verticals/cash/parser.js');

describe('cash parser', () => {
  it('registra despesa simples no mercado', () => {
    const result = deterministicCashParse('Gastei 15 no mercado hoje');
    expect(result).toMatchObject({
      type: 'expense',
      amount: 15,
      category: 'Alimentação',
      merchant: 'mercado'
    });
  });

  it('entende valor brasileiro e receita', () => {
    const result = deterministicCashParse('Recebi R$ 1.250,90 do cliente João');
    expect(result).toMatchObject({ type: 'income', amount: 1250.9 });
  });

  it('não inventa lançamento sem valor', () => {
    expect(deterministicCashParse('Fui ao mercado hoje')).toBeNull();
    expect(deterministicCashParse('Gastei no mercado dia 15')).toBeNull();
  });
});
