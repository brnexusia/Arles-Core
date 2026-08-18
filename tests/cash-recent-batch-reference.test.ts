import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const {
  classifyCashRecentBatchReference,
  summarizeCashRecentBatch
} = await import('../src/verticals/cash/recent-batch.js');

describe('Arles Cash — referência determinística ao último envio', () => {
  it.each([
    'Quero com base no mais recente que mandei',
    'mostra o último envio',
    'use a última mensagem que enviei',
    'considera o último lote',
    'quero os dados que acabei de mandar'
  ])('reconhece referência ao último envio sem IA: %s', input => {
    expect(classifyCashRecentBatchReference(input)).toBe('summary');
  });

  it.each([
    'Sim faça o cálculo com tudo o que ganhei e tudo que gastei nesse último lançamento',
    'calcule entradas e saídas do último envio',
    'soma tudo do último lote',
    'quanto entrou e saiu na última mensagem',
    'qual o resultado do mais recente que mandei',
    'total de receitas e despesas desse último envio'
  ])('reconhece cálculo do lote mais recente sem IA: %s', input => {
    expect(classifyCashRecentBatchReference(input)).toBe('aggregate');
  });

  it.each([
    'quanto gastei no último mês?',
    'receitas da última semana',
    'apaga o último lançamento',
    'edita o último registro',
    'corrige o último lançamento'
  ])('não sequestra períodos nem comandos destrutivos: %s', input => {
    expect(classifyCashRecentBatchReference(input)).toBeNull();
  });

  it('soma receitas e despesas apenas do lote recebido', () => {
    expect(summarizeCashRecentBatch([
      { type: 'income', amount: 76 },
      { type: 'income', amount: 120 },
      { type: 'income', amount: 340 },
      { type: 'expense', amount: 24 },
      { type: 'expense', amount: 38 }
    ])).toEqual({
      income: 536,
      expense: 62,
      balance: 474,
      count: 5
    });
  });
});
