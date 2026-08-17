import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const {
  classifyCashCorpus,
  deterministicCashBatch
} = await import('../src/verticals/cash/conversation-corpus.js');
const { parseCashScheduleCommand } = await import('../src/verticals/cash/schedules.js');
const { deterministicCashParse } = await import('../src/verticals/cash/parser.js');

const NOW = new Date('2026-08-17T13:00:00.000Z');

describe('cash conversation corpus - rotas determinísticas', () => {
  it('separa perguntas/simulações de lançamentos reais', () => {
    const simulations = [
      'tenho saldo de 10, se eu gastar 5,67 quanto fica?',
      'se eu receber 100 e gastar 20 quanto vou ter?',
      'caso eu pague 80 amanhã quanto sobra?',
      'simula meu saldo se entrar 500 e sair 120',
      'calcula quanto fica se eu comprar algo de 30',
      'e se eu ganhar 50 e gastar 10?'
    ];
    for (const phrase of simulations) {
      expect(classifyCashCorpus(phrase).intent, phrase).toBe('projection');
      expect(deterministicCashParse(phrase), phrase).toBeNull();
    }
  });

  it('roteia centenas de lançamentos reais simples sem IA', () => {
    const expenseVerbs = ['gastei', 'paguei', 'comprei', 'debitei'];
    const expenseTargets = ['no mercado', 'no uber', 'na farmácia', 'no almoço', 'na internet', 'no cartão'];
    const values = ['5,67', '20', '45,90', '100', '250,50'];
    let count = 0;
    for (const verb of expenseVerbs) {
      for (const target of expenseTargets) {
        for (const amount of values) {
          const phrase = `${verb} ${amount} ${target}`;
          expect(classifyCashCorpus(phrase).intent, phrase).toBe('transaction');
          expect(deterministicCashParse(phrase), phrase).not.toBeNull();
          count += 1;
        }
      }
    }

    const incomeVerbs = ['recebi', 'ganhei', 'faturei', 'entrou'];
    const incomeSources = ['de salário', 'de freela', 'de uma venda', 'de comissão'];
    for (const verb of incomeVerbs) {
      for (const source of incomeSources) {
        for (const amount of values) {
          const phrase = `${verb} ${amount} ${source}`;
          expect(classifyCashCorpus(phrase).intent, phrase).toBe('transaction');
          expect(deterministicCashParse(phrase), phrase).not.toBeNull();
          count += 1;
        }
      }
    }
    expect(count).toBe(200);
  });

  it('roteia centenas de consultas comuns sem classificador semântico', () => {
    const heads = ['quanto gastei', 'quanto paguei', 'quanto recebi', 'me mostra meus gastos', 'lista minhas despesas'];
    const periods = ['hoje', 'ontem', 'este mês', 'semana passada', 'este ano'];
    const tails = ['', '?', ' por favor?', ' aí?', ' pra mim?'];
    let count = 0;
    for (const head of heads) {
      for (const period of periods) {
        for (const tail of tails) {
          const phrase = `${head} ${period}${tail}`;
          expect(classifyCashCorpus(phrase).intent, phrase).toBe('query');
          count += 1;
        }
      }
    }
    expect(count).toBe(125);
  });

  it('entende cofrinho, caixinha e envelope como a mesma função', () => {
    const containers = ['cofrinho', 'caixinha', 'envelope', 'potinho', 'pote'];
    const actions = ['criar', 'abre', 'faz', 'quero um'];
    const names = ['Emprego', 'Viagem', 'Casa', 'Faculdade'];
    let count = 0;
    for (const container of containers) {
      for (const action of actions) {
        for (const name of names) {
          const phrase = `${action} ${container} ${name}`;
          expect(classifyCashCorpus(phrase).intent, phrase).toBe('pocket');
          count += 1;
        }
      }
    }
    expect(count).toBe(80);
  });

  it('entende listas como vários lançamentos e não como um valor único', () => {
    const expenseList = ['Despesas:', 'Mercado 50', 'Uber 20', 'Internet 100'].join('\n');
    const incomeList = ['Entradas:', 'Salário 2000', 'Freela 500', 'Venda 150'].join('\n');
    expect(classifyCashCorpus(expenseList).intent).toBe('batch_transaction');
    expect(deterministicCashBatch(expenseList)).toHaveLength(3);
    expect(classifyCashCorpus(incomeList).intent).toBe('batch_transaction');
    expect(deterministicCashBatch(incomeList)).toHaveLength(3);
  });
});

describe('cash scheduled forecasts - linguagem natural', () => {
  it('interpreta todo dia N como recorrência mensal, não diária', () => {
    const parsed = parseCashScheduleCommand('todo dia 10 eu gasto 300 no cartão', NOW);
    expect(parsed).toMatchObject({
      kind: 'create',
      draft: { type: 'expense', amount: 300, recurrence: 'monthly', dayOfMonth: 10 }
    });
  });

  it('interpreta mensal, semanal, diário e único', () => {
    expect(parseCashScheduleCommand('todo mês dia 20 recebo 2000 de salário', NOW)).toMatchObject({
      kind: 'create', draft: { type: 'income', amount: 2000, recurrence: 'monthly', dayOfMonth: 20 }
    });
    expect(parseCashScheduleCommand('toda sexta gasto 50 com almoço', NOW)).toMatchObject({
      kind: 'create', draft: { type: 'expense', amount: 50, recurrence: 'weekly', dayOfWeek: 5 }
    });
    expect(parseCashScheduleCommand('todos os dias gasto 12 no café', NOW)).toMatchObject({
      kind: 'create', draft: { type: 'expense', amount: 12, recurrence: 'daily' }
    });
    expect(parseCashScheduleCommand('amanhã vou receber 800 de um cliente', NOW)).toMatchObject({
      kind: 'create', draft: { type: 'income', amount: 800, recurrence: 'once' }
    });
  });

  it('roteia centenas de agendas mensais de gasto e ganho', () => {
    const expenseVerbs = ['gasto', 'pago', 'vou gastar', 'vou pagar'];
    const incomeVerbs = ['recebo', 'ganho', 'vou receber', 'vou ganhar'];
    const days = [1, 5, 10, 15, 20, 25, 30];
    const amounts = [50, 100, 250, 500, 1200];
    let count = 0;

    for (const verb of expenseVerbs) {
      for (const day of days) {
        for (const amount of amounts) {
          const phrase = `todo dia ${day} ${verb} ${amount} no cartão`;
          const parsed = parseCashScheduleCommand(phrase, NOW);
          expect(classifyCashCorpus(phrase).intent, phrase).toBe('schedule');
          expect(parsed, phrase).toMatchObject({
            kind: 'create', draft: { type: 'expense', amount, recurrence: 'monthly', dayOfMonth: day }
          });
          count += 1;
        }
      }
    }

    for (const verb of incomeVerbs) {
      for (const day of days) {
        for (const amount of amounts) {
          const phrase = `todo dia ${day} ${verb} ${amount} de salário`;
          const parsed = parseCashScheduleCommand(phrase, NOW);
          expect(classifyCashCorpus(phrase).intent, phrase).toBe('schedule');
          expect(parsed, phrase).toMatchObject({
            kind: 'create', draft: { type: 'income', amount, recurrence: 'monthly', dayOfMonth: day }
          });
          count += 1;
        }
      }
    }

    expect(count).toBe(280);
  });

  it('roteia centenas de agendas semanais e diárias', () => {
    const weekdays = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
    const amounts = [10, 20, 50, 75, 100];
    const targets = ['almoço', 'transporte', 'academia', 'mercado'];
    let count = 0;
    for (const weekday of weekdays) {
      for (const amount of amounts) {
        for (const target of targets) {
          const phrase = `toda ${weekday} gasto ${amount} com ${target}`;
          expect(parseCashScheduleCommand(phrase, NOW), phrase).toMatchObject({
            kind: 'create', draft: { type: 'expense', amount, recurrence: 'weekly' }
          });
          count += 1;
        }
      }
    }

    for (const amount of amounts) {
      for (const target of targets) {
        const phrase = `todos os dias gasto ${amount} com ${target}`;
        expect(parseCashScheduleCommand(phrase, NOW), phrase).toMatchObject({
          kind: 'create', draft: { type: 'expense', amount, recurrence: 'daily' }
        });
        count += 1;
      }
    }
    expect(count).toBe(140);
  });

  it('entende consultas de previsão sem criar lançamento', () => {
    const projections = [
      'quanto vou ter no fim do mês?',
      'qual meu saldo projetado?',
      'quanto terei depois das contas?',
      'projeção até o final do mês',
      'quanto vou gastar este mês?',
      'quanto vou receber este mês?'
    ];
    for (const phrase of projections) {
      const parsed = parseCashScheduleCommand(phrase, NOW);
      expect(parsed?.kind, phrase).toBe('projection');
      expect(deterministicCashParse(phrase), phrase).toBeNull();
    }
  });

  it('lista e cancela agendas por script', () => {
    expect(parseCashScheduleCommand('meus agendamentos', NOW)).toEqual({ kind: 'list', type: 'all' });
    expect(parseCashScheduleCommand('gastos previstos', NOW)).toEqual({ kind: 'list', type: 'expense' });
    expect(parseCashScheduleCommand('entradas previstas', NOW)).toEqual({ kind: 'list', type: 'income' });
    expect(parseCashScheduleCommand('cancela agendamento 2', NOW)).toEqual({ kind: 'cancel', index: 2 });
  });
});
