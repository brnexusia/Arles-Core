import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const { evaluateCashContextualCalculation } = await import('../src/verticals/cash/contextual-calculation.js');

describe('Cash contextual calculation backend', () => {
  it('resolve o caso contextual 970 - 77 - 140 - 24 = 729 usando IDs reais', () => {
    const result = evaluateCashContextualCalculation({
      base: { kind: 'transaction', transaction_id: 'income-970', amount: 999999 },
      operations: [
        { operator: 'subtract', source: 'transaction', transaction_id: 'expense-77', amount: 1 },
        { operator: 'subtract', source: 'transaction', transaction_id: 'expense-140', amount: 1 },
        { operator: 'subtract', source: 'transaction', transaction_id: 'expense-24', amount: 1 }
      ]
    }, {
      globalBalance: 12_345,
      availableBalance: 10_000,
      transactions: [
        { id: 'income-970', amount: 970 },
        { id: 'expense-77', amount: 77 },
        { id: 'expense-140', amount: 140 },
        { id: 'expense-24', amount: 24 }
      ]
    });

    expect(result?.result).toBe(729);
    expect(result?.base).toBe(970);
  });

  it('usa valores validados do backend e ignora amounts sugeridos pela IA para lançamentos', () => {
    const result = evaluateCashContextualCalculation({
      base: { kind: 'transaction', transaction_id: 'salary', amount: 1 },
      operations: [
        { operator: 'subtract', source: 'transaction', transaction_id: 'rent', amount: 9_999 }
      ]
    }, {
      globalBalance: 0,
      availableBalance: 0,
      transactions: [
        { id: 'salary', amount: 2_000 },
        { id: 'rent', amount: 850 }
      ]
    });

    expect(result).toEqual({
      base: 2_000,
      steps: [{ operator: 'subtract', amount: 850 }],
      result: 1_150
    });
  });

  it('suporta referência ao saldo disponível com operações literais sem alterar o saldo', () => {
    const result = evaluateCashContextualCalculation({
      base: { kind: 'available_balance', transaction_id: null, amount: null },
      operations: [
        { operator: 'subtract', source: 'literal', transaction_id: null, amount: 120.5 },
        { operator: 'add', source: 'literal', transaction_id: null, amount: 20.25 }
      ]
    }, {
      globalBalance: 1_000,
      availableBalance: 600,
      transactions: []
    });

    expect(result?.result).toBe(499.75);
  });

  it('suporta conta factual com base literal e centavos', () => {
    const result = evaluateCashContextualCalculation({
      base: { kind: 'literal', transaction_id: null, amount: 500.1 },
      operations: [
        { operator: 'subtract', source: 'literal', transaction_id: null, amount: 30.05 },
        { operator: 'add', source: 'literal', transaction_id: null, amount: 10 }
      ]
    }, {
      globalBalance: 0,
      availableBalance: 0,
      transactions: []
    });

    expect(result?.result).toBe(480.05);
  });

  it('recusa referência a lançamento inexistente em vez de cair no saldo global', () => {
    const result = evaluateCashContextualCalculation({
      base: { kind: 'transaction', transaction_id: 'missing', amount: 970 },
      operations: [
        { operator: 'subtract', source: 'literal', transaction_id: null, amount: 10 }
      ]
    }, {
      globalBalance: 50_000,
      availableBalance: 50_000,
      transactions: [{ id: 'another', amount: 970 }]
    });

    expect(result).toBeNull();
  });
});
