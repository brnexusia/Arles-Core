import { describe, expect, it } from 'vitest';
import {
  expandCashFinancialIntentFollowup,
  type CashFinancialIntentContext
} from '../src/verticals/cash/intent-context.js';

function previous(overrides: Partial<CashFinancialIntentContext> = {}): CashFinancialIntentContext {
  return {
    version: 1,
    kind: 'aggregate',
    operation: 'sum',
    flow: 'both',
    scope: 'period',
    periodCanonical: 'este mês',
    reference: null,
    canonical: 'quanto entrou e quanto saiu este mês?',
    rememberedAt: new Date(0).toISOString(),
    ...overrides
  };
}

describe('Arles Cash — contexto financeiro tipado', () => {
  it.each([
    ['e ontem?', 'quanto entrou e quanto saiu ontem?'],
    ['hoje', 'quanto entrou e quanto saiu hoje?'],
    ['e mês passado?', 'quanto entrou e quanto saiu mês passado?'],
    ['esta semana', 'quanto entrou e quanto saiu esta semana?']
  ])('troca somente o período sem reinterpretar a intenção anterior: %s', (input, expected) => {
    expect(expandCashFinancialIntentFollowup(previous(), input)).toBe(expected);
  });

  it('completa uma consulta que estava aguardando período', () => {
    const awaitingPeriod = previous({
      kind: 'query',
      operation: 'read',
      flow: 'expense',
      scope: 'unspecified',
      periodCanonical: null,
      canonical: 'quanto gastei hoje?'
    });

    expect(expandCashFinancialIntentFollowup(awaitingPeriod, 'este mês')).toBe('quanto gastei este mês?');
    expect(expandCashFinancialIntentFollowup(awaitingPeriod, 'mês passado')).toBe('quanto gastei mês passado?');
    expect(expandCashFinancialIntentFollowup(awaitingPeriod, 'no total')).toBe('total geral de todas as despesas');
  });

  it('preserva o fluxo ao pedir total histórico depois de uma consulta', () => {
    const income = previous({ kind: 'query', flow: 'income', canonical: 'quanto recebi este mês?' });
    expect(expandCashFinancialIntentFollowup(income, 'e no total?')).toBe('total geral de todas as receitas');
  });

  it('troca apenas o lado financeiro quando o usuário pede só entradas ou só saídas', () => {
    expect(expandCashFinancialIntentFollowup(previous(), 'e só entradas?')).toBe('quanto recebi este mês?');
    expect(expandCashFinancialIntentFollowup(previous(), 'só despesas')).toBe('quanto gastei este mês?');
  });

  it('usa total histórico ao trocar o fluxo de um contexto acumulado', () => {
    const allTime = previous({ scope: 'all_time', periodCanonical: null });
    expect(expandCashFinancialIntentFollowup(allTime, 'só receitas')).toBe('total geral de todas as receitas');
    expect(expandCashFinancialIntentFollowup(allTime, 'só gastos')).toBe('total geral de todas as despesas');
  });

  it.each([
    'apaga ele',
    'muda o valor para 50',
    'qual foi o gasto do mercado?',
    'quero criar um cofrinho',
    'texto longo que não é um modificador de contexto'
  ])('não expande mensagens que não são continuação curta e inequívoca: %s', input => {
    expect(expandCashFinancialIntentFollowup(previous(), input)).toBeNull();
  });
});
