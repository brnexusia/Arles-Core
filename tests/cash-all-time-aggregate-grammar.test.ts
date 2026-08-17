import { describe, expect, it } from 'vitest';
import {
  hasCashExplicitAggregatePeriod,
  isCashAllTimeTotalsRequest
} from '../src/verticals/cash/aggregate-intent.js';

describe('Arles Cash — gramática determinística de totais acumulados', () => {
  it.each([
    'Me mande o valor total de tudo quanto eu ganhei e quanto eu gastei',
    'Some o valor dos lançamentos referente ao que eu ganhei e que eu gastei',
    'me mostra o total geral do que entrou e do que saiu',
    'quanto já entrou e quanto já saiu?',
    'qual o acumulado de receitas e despesas?',
    'soma todos os lançamentos pra mim',
    'me passa o balanço geral de entradas e saídas',
    'quanto eu recebi e gastei no total?',
    'mostra tudo que eu ganhei e tudo que eu gastei',
    'total de todos os meus registros'
  ])('reconhece total acumulado: %s', input => {
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
          expect(isCashAllTimeTotalsRequest(input), input).toBe(true);
          checked += 1;
        }
      }
    }

    expect(checked).toBe(1152);
  });

  it.each([
    'me mande o valor total de tudo que ganhei e gastei hoje',
    'some entradas e saídas deste mês',
    'qual o total geral de receitas e despesas semana passada',
    'soma todos os lançamentos de ontem',
    'quanto já entrou e quanto já saiu hoje?',
    'total de gastos em agosto',
    'balanço geral do ano passado',
    'some tudo dos últimos 30 dias'
  ])('mantém período explícito no motor por período: %s', input => {
    expect(hasCashExplicitAggregatePeriod(input)).toBe(true);
    expect(isCashAllTimeTotalsRequest(input)).toBe(false);
  });

  it.each([
    'me mostra o total do cofrinho Viagem',
    'quanto tem no cofrinho?',
    'soma os valores da caixinha Reserva'
  ])('não sequestra consultas de cofrinho: %s', input => {
    expect(isCashAllTimeTotalsRequest(input)).toBe(false);
  });

  it.each([
    'me mostra tudo que entrou até hoje',
    'balanço de tudo desde o início',
    'quanto entrou e saiu desde que comecei',
    'total acumulado até agora'
  ])('entende limites históricos como acumulado: %s', input => {
    expect(isCashAllTimeTotalsRequest(input)).toBe(true);
  });
});
