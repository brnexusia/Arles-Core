import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const { interpretCashFinancialIntent } = await import('../src/verticals/cash/financial-intent.js');

describe('Arles Cash — contrato tipado de simulação', () => {
  it('carrega as operações no objeto de intenção em vez de deixar o executor reinterpretar valores', () => {
    const intent = interpretCashFinancialIntent('se eu gastar 50 e receber 20 quanto fica?');
    expect(intent).toMatchObject({
      kind: 'projection',
      operation: 'simulate',
      mutation: false,
      projection: {
        explicitBase: null,
        operations: [
          { type: 'expense', amount: 50 },
          { type: 'income', amount: 20 }
        ]
      }
    });
  });

  it('mantém simulação de cofrinho no domínio de projeção', () => {
    const intent = interpretCashFinancialIntent('se eu gastar 50 do cofrinho Viagem quanto sobra?');
    expect(intent?.kind).toBe('projection');
    expect(intent?.projection?.operations).toEqual([{ type: 'expense', amount: 50 }]);
  });

  it.each([
    'gastei 50 no cofrinho Viagem',
    'quanto gastei no cofrinho Viagem?',
    'saldo do cofrinho Viagem'
  ])('não transforma operação normal de cofrinho em simulação: %s', input => {
    expect(interpretCashFinancialIntent(input)?.kind).not.toBe('projection');
  });
});
