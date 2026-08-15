import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const { deterministicCashParse, categoryFrom } = await import('../src/verticals/cash/parser.js');

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
    expect(result).toMatchObject({
      type: 'income',
      amount: 1250.9,
      category: 'Receita'
    });
  });

  it('aceita despesas curtas sem verbo', () => {
    expect(deterministicCashParse('farmácia 45')).toMatchObject({
      type: 'expense',
      amount: 45,
      category: 'Saúde'
    });
    expect(deterministicCashParse('120 no almoço')).toMatchObject({
      type: 'expense',
      amount: 120,
      category: 'Alimentação'
    });
  });

  it('aceita inteiro, vírgula e ponto decimal', () => {
    expect(deterministicCashParse('mercado 4')?.amount).toBe(4);
    expect(deterministicCashParse('mercado 4,50')?.amount).toBe(4.5);
    expect(deterministicCashParse('mercado 4.50')?.amount).toBe(4.5);
  });

  it('usa as categorias domésticas fechadas', () => {
    expect(categoryFrom('gasolina', 'expense')).toBe('Transporte');
    expect(categoryFrom('plano de saúde', 'expense')).toBe('Saúde');
    expect(categoryFrom('condomínio', 'expense')).toBe('Moradia');
    expect(categoryFrom('faculdade', 'expense')).toBe('Educação');
    expect(categoryFrom('academia', 'expense')).toBe('Pessoal');
    expect(categoryFrom('qualquer entrada', 'income')).toBe('Receita');
    expect(categoryFrom('coisa diferente', 'expense')).toBe('Outros');
  });

  it('não inventa lançamento sem valor', () => {
    expect(deterministicCashParse('Fui ao mercado hoje')).toBeNull();
    expect(deterministicCashParse('Gastei no mercado dia 15')).toBeNull();
  });
});
