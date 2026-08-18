import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const {
  hasCashExplicitFinancialPeriod,
  interpretCashFinancialIntent
} = await import('../src/verticals/cash/financial-intent.js');

describe('Arles Cash — interpretador financeiro central', () => {
  it('resolve exatamente a regressão de referência ao último envio', () => {
    expect(interpretCashFinancialIntent('Quero com base no mais recente que mandei')).toMatchObject({
      kind: 'recent_batch', operation: 'read', scope: 'recent_batch', reference: 'recent_batch', needsClarification: null
    });

    expect(interpretCashFinancialIntent('Sim faça o cálculo com tudo o que ganhei e tudo que gastei nesse último lançamento')).toMatchObject({
      kind: 'recent_batch', operation: 'sum', flow: 'both', scope: 'recent_batch', reference: 'recent_batch', needsClarification: null
    });
  });

  it.each([
    'calcule o último envio',
    'some o último lote',
    'quanto deu na última mensagem',
    'faz o balanço do último lançamento',
    'calcula esses dados que acabei de mandar',
    'me mostra o que eu acabei de enviar',
    'quero usar a última coisa que mandei'
  ])('mantém referências recentes fora do período hoje: %s', input => {
    const intent = interpretCashFinancialIntent(input);
    expect(intent?.kind).toBe('recent_batch');
    expect(intent?.scope).toBe('recent_batch');
    expect(intent?.periodCanonical).toBeNull();
  });

  it.each([
    'apaga o último lançamento',
    'edita o último registro',
    'remove esse último lançamento',
    'corrige o último registro'
  ])('não sequestra gestão destrutiva: %s', input => {
    expect(interpretCashFinancialIntent(input)).toBeNull();
  });

  it.each([
    ['quanto gastei no último mês?', 'period'],
    ['quanto recebi na última semana?', 'period'],
    ['gastos dos últimos 30 dias', 'period']
  ])('não confunde períodos com referência recente: %s', (input, scope) => {
    const intent = interpretCashFinancialIntent(input);
    expect(intent?.kind).not.toBe('recent_batch');
    expect(intent?.scope).toBe(scope);
  });

  it.each([
    'Faça o cálculo com tudo o que ganhei e tudo o que gastei',
    'calcule tudo que entrou e tudo que saiu',
    'some todas as receitas e despesas',
    'qual o total geral do que recebi e paguei',
    'me dê o balanço de todos os lançamentos',
    'quanto já entrou e quanto já saiu no total?'
  ])('interpreta total histórico de ambos os fluxos: %s', input => {
    expect(interpretCashFinancialIntent(input)).toMatchObject({
      kind: 'aggregate', operation: 'sum', flow: 'both', scope: 'all_time', needsClarification: null
    });
  });

  it('preserva a semântica em mais de 1.500 combinações, não frases cadastradas', () => {
    const verbs = [
      'calcule', 'some', 'soma', 'totalize',
      'calcule o total de', 'me diga o total de', 'me mostra o total de', 'faça o balanço de'
    ];
    const incomes = [
      'o que ganhei', 'o que recebi', 'as receitas', 'as entradas',
      'o que entrou', 'meus ganhos', 'meus recebimentos', 'minhas vendas'
    ];
    const expenses = [
      'o que gastei', 'o que paguei', 'as despesas', 'as saídas',
      'o que saiu', 'meus gastos', 'minhas compras', 'meus pagamentos'
    ];
    const forms = [
      (income: string, expense: string) => `tudo ${income} e tudo ${expense}`,
      (income: string, expense: string) => `tudo ${expense} e tudo ${income}`,
      (income: string, expense: string) => `todos os lançamentos: ${income} e ${expense}`
    ];

    let checked = 0;
    for (const verb of verbs) {
      for (const income of incomes) {
        for (const expense of expenses) {
          for (const form of forms) {
            const input = `${verb} ${form(income, expense)}`;
            const intent = interpretCashFinancialIntent(input);
            expect(intent?.kind, input).toBe('aggregate');
            expect(intent?.flow, input).toBe('both');
            expect(intent?.scope, input).toBe('all_time');
            expect(intent?.needsClarification, input).toBeNull();
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(1536);
  });

  it.each([
    ['quanto gastei?', 'expense'],
    ['quanto recebi?', 'income'],
    ['quanto gastei no mercado?', 'expense'],
    ['me mostra minhas receitas', 'income']
  ])('não inventa hoje quando o período está ausente: %s', (input, flow) => {
    const intent = interpretCashFinancialIntent(input);
    expect(intent).toMatchObject({ flow, scope: 'unspecified', needsClarification: 'period' });
    expect(intent?.periodCanonical).toBeNull();
  });

  it.each([
    ['quanto gastei hoje?', 'hoje'],
    ['quanto recebi este mês?', 'este mês'],
    ['quanto gastei mês passado?', 'mês passado'],
    ['me mostra minhas receitas em agosto', 'agosto']
  ])('preserva período explícito: %s', (input, period) => {
    expect(hasCashExplicitFinancialPeriod(input)).toBe(true);
    const intent = interpretCashFinancialIntent(input);
    expect(intent?.needsClarification).toBeNull();
    expect(intent?.periodCanonical).toBe(period);
  });

  it.each([
    ['Gastei 50 no mercado', 'expense', 50],
    ['Recebi 200 de um freela', 'income', 200],
    ['Ontem eu gastei na pizzaria 5,00', 'expense', 5]
  ])('lançamento simples vira objeto tipado uma única vez: %s', (input, flow, amount) => {
    const intent = interpretCashFinancialIntent(input);
    expect(intent).toMatchObject({ kind: 'transaction', operation: 'register', flow, mutation: true });
    expect(intent?.transaction?.amount).toBe(amount);
  });

  it.each([
    'Recebi 100 e gastei 50',
    'gastei 20 no mercado e recebi 300 de freela',
    'recebi 100; recebi 200; gastei 50'
  ])('mensagem com múltiplos movimentos não vira um lançamento único: %s', input => {
    expect(interpretCashFinancialIntent(input)?.kind).not.toBe('transaction');
  });

  it.each([
    'saldo',
    'quanto eu tenho?',
    'qual é meu saldo',
    'quanto me resta'
  ])('saldo é leitura acumulada, nunca transação: %s', input => {
    expect(interpretCashFinancialIntent(input)).toMatchObject({
      kind: 'balance', operation: 'read', mutation: false, scope: 'all_time'
    });
  });

  it.each([
    'se eu gastar 50 quanto sobra?',
    'simula se eu receber 300 quanto fica meu saldo',
    'só calcula se eu pagar 90'
  ])('simulação nunca vira registro: %s', input => {
    expect(interpretCashFinancialIntent(input)).toMatchObject({
      kind: 'projection', operation: 'simulate', mutation: false
    });
  });

  it('mantém a informação futura como espera, não como lançamento', () => {
    expect(interpretCashFinancialIntent('Eu ainda vou enviar quem está me devendo e quanto tem no caixa')).toMatchObject({
      kind: 'future_data', operation: 'wait', mutation: false
    });
  });
});
