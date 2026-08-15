import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const { deterministicCashQuery } = await import('../src/verticals/cash/query.js');
const { currentMonthWindow, dateIsoOffset } = await import('../src/verticals/cash/time.js');

describe('cash natural query', () => {
  it('consulta tudo que gastou ontem', () => {
    expect(deterministicCashQuery('Quanto gastei ontem?')).toMatchObject({
      type: 'expense',
      from: dateIsoOffset(-1),
      to: dateIsoOffset(-1),
      periodLabel: 'ontem'
    });
  });

  it('usa o mês atual quando a pesquisa por loja não informa data', () => {
    const period = currentMonthWindow();
    expect(deterministicCashQuery('Quanto gastei na SHEIN?')).toMatchObject({
      type: 'expense',
      from: period.from,
      to: period.to,
      term: 'SHEIN',
      periodLabel: 'este mês'
    });
  });

  it('filtra categoria explícita e período', () => {
    expect(deterministicCashQuery('Mostra minhas despesas de Alimentação esse mês')).toMatchObject({
      type: 'expense',
      category: 'Alimentação',
      term: null,
      periodLabel: 'este mês'
    });
  });

  it('entende intervalo de dias no mês atual', () => {
    const result = deterministicCashQuery('Quanto gastei entre dia 1 e dia 10?');
    expect(result?.from.endsWith('-01')).toBe(true);
    expect(result?.to.endsWith('-10')).toBe(true);
  });

  it('entende filtros de valor e ranking', () => {
    expect(deterministicCashQuery('Mostra minhas maiores despesas acima de 100 reais este mês')).toMatchObject({
      type: 'expense',
      minAmount: 100,
      sort: 'amount_desc'
    });
    expect(deterministicCashQuery('Qual foi meu maior gasto este mês?')).toMatchObject({
      type: 'expense',
      sort: 'amount_desc',
      limit: 1
    });
  });

  it('não confunde um lançamento com uma consulta', () => {
    expect(deterministicCashQuery('Gastei 50 no mercado')).toBeNull();
  });
});
