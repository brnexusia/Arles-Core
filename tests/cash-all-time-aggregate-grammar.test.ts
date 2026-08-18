import { describe, expect, it } from 'vitest';
import {
  hasCashExplicitAggregatePeriod,
  isCashAllTimeTotalsRequest,
  parseCashAggregateIntent
} from '../src/verticals/cash/aggregate-intent.js';

describe('Arles Cash — gramática determinística de totais financeiros', () => {
  it.each([
    'Me mande o valor total de tudo quanto eu ganhei e quanto eu gastei',
    'Some o valor dos lançamentos referente ao que eu ganhei e que eu gastei',
    'me mostra o total geral do que entrou e do que saiu',
    'quanto já entrou e quanto já saiu?',
    'qual o acumulado de receitas e despesas?',
    'soma todos os lançamentos pra mim',
    'me passa o balanço geral de entradas e saídas',
    'quanto eu recebi e gastei no total?',
    'mostra o total de tudo que eu ganhei e tudo que eu gastei',
    'total de todos os meus registros'
  ])('reconhece total acumulado: %s', input => {
    const parsed = parseCashAggregateIntent(input);
    expect(parsed).not.toBeNull();
    expect(parsed?.scope).toBe('all_time');
    expect(isCashAllTimeTotalsRequest(input)).toBe(true);
  });

  it('generaliza mais de 1.000 formulações sem cadastro literal', () => {
    const prefixes = [
      'me mande', 'me manda', 'me fala', 'me diga', 'mostra', 'mostre',
      'me passa', 'traz', 'traga', 'quero saber', 'calcula', 'calcule'
    ];
    const aggregates = [
      'o total geral',
      'o valor total de tudo',
      'o acumulado',
      'o balanço geral',
      'a soma geral',
      'o total de todos os lançamentos',
      'o valor acumulado',
      'quanto deu tudo'
    ];
    const pairs = [
      'do que eu ganhei e do que eu gastei',
      'de tudo que entrou e tudo que saiu',
      'das entradas e das saídas',
      'das receitas e das despesas',
      'do que recebi e do que paguei',
      'do que entrou e do que saiu',
      'do dinheiro que entrou e do dinheiro que saiu',
      'dos meus ganhos e dos meus gastos',
      'do que faturei e do que gastei',
      'do que vendi e do que paguei',
      'do que recebi e do que comprei',
      'de tudo o que ganhei e tudo o que gastei'
    ];

    let checked = 0;
    for (const prefix of prefixes) {
      for (const aggregate of aggregates) {
        for (const pair of pairs) {
          const input = `${prefix} ${aggregate} ${pair}`;
          expect(parseCashAggregateIntent(input), input).toMatchObject({ scope: 'all_time' });
          checked += 1;
        }
      }
    }

    expect(checked).toBe(1152);
  });

  it.each([
    ['me mande o valor total de tudo que ganhei e gastei hoje', 'both', 'hoje'],
    ['some entradas e saídas deste mês', 'both', 'este mês'],
    ['qual o total geral de receitas e despesas semana passada', 'both', 'semana passada'],
    ['soma todos os lançamentos de ontem', 'both', 'ontem'],
    ['quanto já entrou e quanto já saiu hoje?', 'both', 'hoje'],
    ['total de gastos em agosto', 'expense', 'agosto'],
    ['balanço geral do ano passado', 'both', 'ano passado'],
    ['some tudo dos últimos 30 dias', 'both', 'últimos 30 dias']
  ])('período explícito vence totalidade: %s', (input, flow, periodCanonical) => {
    expect(hasCashExplicitAggregatePeriod(input)).toBe(true);
    expect(parseCashAggregateIntent(input)).toMatchObject({
      scope: 'period',
      flow,
      periodCanonical
    });
  });

  it.each([
    ['soma tudo que recebi', 'income'],
    ['quanto recebi no total?', 'income'],
    ['total geral do que gastei', 'expense'],
    ['soma todas as despesas desde o início', 'expense']
  ])('preserva o lado financeiro em totais históricos: %s', (input, flow) => {
    expect(parseCashAggregateIntent(input)).toMatchObject({ scope: 'all_time', flow });
  });

  it.each([
    'me mostra o total do cofrinho Viagem',
    'quanto tem no cofrinho?',
    'soma os valores da caixinha Reserva',
    'quanto gastei na SHEIN este mês?',
    'quanto gastei com alimentação hoje?',
    'qual foi meu maior gasto este mês?',
    'gastei 50 no total'
  ])('não sequestra cofrinho, filtros ou lançamentos: %s', input => {
    expect(parseCashAggregateIntent(input)).toBeNull();
  });

  it.each([
    'me mostra o total de tudo que entrou até hoje',
    'balanço de tudo desde o início',
    'quanto entrou e saiu desde que comecei',
    'total acumulado de entradas e saídas até agora'
  ])('entende limites históricos como acumulado: %s', input => {
    expect(parseCashAggregateIntent(input)).toMatchObject({ scope: 'all_time' });
  });
});
