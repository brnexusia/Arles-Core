import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const { classifyCashCorpus } = await import('../src/verticals/cash/conversation-corpus.js');
const { parseCashScheduleCommand } = await import('../src/verticals/cash/schedules.js');
const { deterministicCashParse } = await import('../src/verticals/cash/parser.js');
const { isCashProtectedNonTransaction } = await import('../src/verticals/cash/ledger.js');
const { cashHelpSection } = await import('../src/verticals/cash/help.js');

const NOW = new Date('2026-08-17T13:00:00.000Z');

describe('cash matrix - linguagem do cliente', () => {
  it('cobre centenas de formas de registrar despesas reais', () => {
    const verbs = ['gastei', 'paguei', 'comprei', 'debitei'];
    const amounts = ['5', '12,50', '39,90', '80', '120', '250,75'];
    const targets = ['no mercado', 'no uber', 'na farmácia', 'no almoço', 'na internet', 'na academia', 'na SHEIN', 'com gasolina'];
    const suffixes = ['', ' hoje', ' agora', ' ontem'];
    let count = 0;
    for (const verb of verbs) for (const amount of amounts) for (const target of targets) for (const suffix of suffixes) {
      const phrase = `${verb} ${amount} ${target}${suffix}`;
      expect(classifyCashCorpus(phrase).intent, phrase).toBe('transaction');
      expect(deterministicCashParse(phrase), phrase).not.toBeNull();
      count += 1;
    }
    expect(count).toBe(768);
  });

  it('cobre centenas de formas de registrar entradas reais', () => {
    const verbs = ['recebi', 'ganhei', 'faturei', 'entrou'];
    const amounts = ['20', '50', '100', '350,50', '800', '2000'];
    const sources = ['de salário', 'de freela', 'de uma venda', 'de comissão', 'do cliente', 'de pix'];
    const suffixes = ['', ' hoje', ' agora', ' ontem'];
    let count = 0;
    for (const verb of verbs) for (const amount of amounts) for (const source of sources) for (const suffix of suffixes) {
      const phrase = `${verb} ${amount} ${source}${suffix}`;
      expect(classifyCashCorpus(phrase).intent, phrase).toBe('transaction');
      expect(deterministicCashParse(phrase), phrase).not.toBeNull();
      count += 1;
    }
    expect(count).toBe(576);
  });

  it('cobre centenas de consultas por período sem IA semântica', () => {
    const starts = ['quanto gastei', 'quanto paguei', 'quanto recebi', 'me mostra meus gastos', 'lista minhas despesas', 'lista minhas entradas'];
    const periods = ['hoje', 'ontem', 'anteontem', 'esta semana', 'semana passada', 'este mês', 'mês passado', 'este ano'];
    const endings = ['', '?', ' aí?', ' por favor?', ' pra mim?', ' mesmo?'];
    let count = 0;
    for (const start of starts) for (const period of periods) for (const ending of endings) {
      const phrase = `${start} ${period}${ending}`;
      expect(classifyCashCorpus(phrase).intent, phrase).toBe('query');
      count += 1;
    }
    expect(count).toBe(288);
  });

  it('cobre centenas de hipóteses sem registrar dinheiro', () => {
    const starts = ['se eu', 'caso eu', 'e se eu'];
    const verbs = ['gastar', 'gaste', 'pagar', 'pague', 'comprar', 'receber', 'ganhar'];
    const amounts = ['5', '5,67', '20', '50', '120,90'];
    const endings = ['quanto fica?', 'quanto sobra?', 'qual fica meu saldo?', 'quanto eu teria?', 'quanto vou ter?'];
    let count = 0;
    for (const start of starts) for (const verb of verbs) for (const amount of amounts) for (const ending of endings) {
      const phrase = `${start} ${verb} ${amount}, ${ending}`;
      expect(classifyCashCorpus(phrase).intent, phrase).toBe('projection');
      expect(isCashProtectedNonTransaction(phrase), phrase).toBe(true);
      expect(deterministicCashParse(phrase), phrase).toBeNull();
      count += 1;
    }
    expect(count).toBe(525);
  });

  it('cobre linguagem social sem usar IA', () => {
    const greetings = ['oi', 'oii', 'olá', 'opa', 'e aí', 'eae', 'bom dia', 'boa tarde', 'boa noite', 'salve', 'hey', 'hello'];
    const acknowledgements = ['ok', 'okay', 'certo', 'beleza', 'blz', 'entendi', 'show', 'perfeito', 'valeu', 'obrigado', 'obrigada', 'massa', 'top', 'fechou', 'tranquilo', 'show de bola'];
    for (const phrase of greetings) expect(classifyCashCorpus(phrase).intent, phrase).toBe('greeting');
    for (const phrase of acknowledgements) expect(classifyCashCorpus(phrase).intent, phrase).toBe('acknowledgement');
  });
});

describe('cash matrix - agenda e previsão', () => {
  it('cobre centenas de despesas mensais recorrentes', () => {
    const verbs = ['gasto', 'pago', 'vou gastar', 'vou pagar'];
    const days = [1, 5, 10, 15, 20, 25, 30];
    const amounts = [30, 50, 100, 250, 500, 900];
    const labels = ['cartão', 'internet', 'aluguel', 'academia', 'assinatura'];
    let count = 0;
    for (const verb of verbs) for (const day of days) for (const amount of amounts) for (const label of labels) {
      const phrase = `todo dia ${day} ${verb} ${amount} com ${label}`;
      expect(classifyCashCorpus(phrase).intent, phrase).toBe('schedule');
      expect(parseCashScheduleCommand(phrase, NOW), phrase).toMatchObject({
        kind: 'create', draft: { type: 'expense', amount, recurrence: 'monthly', dayOfMonth: day }
      });
      expect(deterministicCashParse(phrase), phrase).toBeNull();
      count += 1;
    }
    expect(count).toBe(840);
  });

  it('cobre centenas de entradas mensais recorrentes', () => {
    const verbs = ['recebo', 'ganho', 'vou receber', 'vou ganhar'];
    const days = [1, 5, 10, 15, 20, 25, 30];
    const amounts = [100, 300, 800, 1200, 2000];
    const labels = ['salário', 'freela', 'comissão', 'cliente'];
    let count = 0;
    for (const verb of verbs) for (const day of days) for (const amount of amounts) for (const label of labels) {
      const phrase = `todo dia ${day} ${verb} ${amount} de ${label}`;
      expect(classifyCashCorpus(phrase).intent, phrase).toBe('schedule');
      expect(parseCashScheduleCommand(phrase, NOW), phrase).toMatchObject({
        kind: 'create', draft: { type: 'income', amount, recurrence: 'monthly', dayOfMonth: day }
      });
      expect(deterministicCashParse(phrase), phrase).toBeNull();
      count += 1;
    }
    expect(count).toBe(560);
  });

  it('cobre previsões semanais e diárias', () => {
    const weekdays = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];
    const amounts = [10, 25, 50, 100];
    const labels = ['almoço', 'transporte', 'mercado', 'academia'];
    let weekly = 0;
    for (const weekday of weekdays) for (const amount of amounts) for (const label of labels) {
      const phrase = `toda ${weekday} gasto ${amount} com ${label}`;
      expect(parseCashScheduleCommand(phrase, NOW), phrase).toMatchObject({ kind: 'create', draft: { type: 'expense', recurrence: 'weekly' } });
      weekly += 1;
    }
    expect(weekly).toBe(112);

    let daily = 0;
    for (const amount of amounts) for (const label of labels) {
      const phrase = `todos os dias gasto ${amount} com ${label}`;
      expect(parseCashScheduleCommand(phrase, NOW), phrase).toMatchObject({ kind: 'create', draft: { type: 'expense', recurrence: 'daily' } });
      daily += 1;
    }
    expect(daily).toBe(16);
  });

  it('cobre previsões únicas no futuro sem registrar como real', () => {
    const times = ['amanhã', 'depois de amanhã', 'daqui a 3 dias', 'daqui a 10 dias'];
    const income = ['vou receber', 'vou ganhar'];
    const expense = ['vou gastar', 'vou pagar'];
    const amounts = [50, 200, 800];
    let count = 0;
    for (const time of times) for (const verb of income) for (const amount of amounts) {
      const phrase = `${time} ${verb} ${amount} de um cliente`;
      expect(parseCashScheduleCommand(phrase, NOW), phrase).toMatchObject({ kind: 'create', draft: { type: 'income', amount, recurrence: 'once' } });
      expect(deterministicCashParse(phrase), phrase).toBeNull();
      count += 1;
    }
    for (const time of times) for (const verb of expense) for (const amount of amounts) {
      const phrase = `${time} ${verb} ${amount} no cartão`;
      expect(parseCashScheduleCommand(phrase, NOW), phrase).toMatchObject({ kind: 'create', draft: { type: 'expense', amount, recurrence: 'once' } });
      expect(deterministicCashParse(phrase), phrase).toBeNull();
      count += 1;
    }
    expect(count).toBe(48);
  });

  it('distingue consulta de previsão de criação', () => {
    const phrases = [
      'quanto vou ter no fim do mês?',
      'quanto terei no final do mês?',
      'qual meu saldo projetado?',
      'como fica meu saldo depois das contas?',
      'quanto vou gastar este mês?',
      'quanto vou receber este mês?',
      'previsão de saldo',
      'projeção até o fim do mês'
    ];
    for (const phrase of phrases) {
      expect(classifyCashCorpus(phrase).intent, phrase).toBe('schedule');
      expect(parseCashScheduleCommand(phrase, NOW)?.kind, phrase).toBe('projection');
      expect(deterministicCashParse(phrase), phrase).toBeNull();
    }
  });

  it('mantém agenda dentro de cofrinho como previsão, não como comando de cofrinho', () => {
    const names = ['Emprego', 'Casa', 'Viagem', 'Cartão'];
    for (const name of names) {
      const expense = `todo dia 10 gasto 300 no cofrinho ${name}`;
      const income = `todo dia 5 recebo 2000 no cofrinho ${name}`;
      expect(classifyCashCorpus(expense).intent, expense).toBe('schedule');
      expect(classifyCashCorpus(income).intent, income).toBe('schedule');
      expect(parseCashScheduleCommand(expense, NOW)?.kind).toBe('create');
      expect(parseCashScheduleCommand(income, NOW)?.kind).toBe('create');
    }
  });
});

describe('cash matrix - gestão, ajuda e respostas curtas', () => {
  it('roteia edição e exclusão por script', () => {
    const edits = ['edita o último', 'corrige o último', 'altera o registro 2', 'muda o valor do 2', 'errei o último', 'ajusta o registro 3'];
    const deletes = ['apaga o último', 'exclui o 2', 'remove o registro 3', 'retira o último', 'deleta o 2', 'cancela esse'];
    for (const phrase of edits) expect(classifyCashCorpus(phrase).intent, phrase).toBe('edit');
    for (const phrase of deletes) expect(classifyCashCorpus(phrase).intent, phrase).toBe('delete');
  });

  it('roteia ajuda por seção sem IA', () => {
    const cases: Array<[string, string]> = [
      ['como registro uma despesa?', 'register'],
      ['como consulto meus gastos?', 'query'],
      ['como uso cofrinhos?', 'pockets'],
      ['como faço um agendamento?', 'forecasts'],
      ['como edito um registro?', 'manage'],
      ['como funciona relatório mensal?', 'reports'],
      ['como vejo os planos?', 'plans']
    ];
    for (const [phrase, expected] of cases) expect(cashHelpSection(phrase), phrase).toBe(expected);
  });

  it('roteia relatórios e histórico', () => {
    const weekly = ['relatório semanal', 'resumo da semana', 'fechamento semanal', 'como foi a semana'];
    const monthly = ['relatório mensal', 'resumo do mês', 'fechamento mensal', 'como foi o mês'];
    const history = ['histórico', 'meus registros', 'meus lançamentos', 'o que registrei'];
    for (const phrase of weekly) expect(classifyCashCorpus(phrase).intent, phrase).toBe('weekly_report');
    for (const phrase of monthly) expect(classifyCashCorpus(phrase).intent, phrase).toBe('monthly_report');
    for (const phrase of history) expect(classifyCashCorpus(phrase).intent, phrase).toBe('history');
  });
});
