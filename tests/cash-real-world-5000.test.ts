import { beforeAll, describe, expect, it } from 'vitest';

type Route =
  | 'greeting'
  | 'acknowledgement'
  | 'transaction'
  | 'batch_transaction'
  | 'query'
  | 'history'
  | 'balance'
  | 'projection'
  | 'pocket'
  | 'pocket-balance'
  | 'pocket-delete'
  | 'schedule'
  | 'weekly_report'
  | 'monthly_report'
  | 'edit'
  | 'delete'
  | 'undo'
  | 'help'
  | 'plans'
  | 'trial'
  | 'categories'
  | 'ai-fallback';

type Scenario = {
  expected: Route;
  variants: string[];
};

let classifyCashCorpus: (input: string) => { intent: string };
let classifyCashDeterministicLanguage: (input: string) => { intent: string; canonical: string } | null;
let deterministicCashParse: (input: string) => unknown;
let deterministicCashQuery: (input: string) => unknown;
let isCashDirectBalanceRequest: (input: string) => boolean;
let isCashForecastLanguage: (input: string) => boolean;
let parseCashProjection: (input: string) => unknown;
let isCashNaturalRecordListRequest: (input: string) => boolean;
let parseCashPocketDeleteReference: (input: string) => unknown;
let parseCashPocketBalanceReference: (input: string) => { kind: 'explicit-all' | 'context' } | null;
let parseCashReportRequest: (input: string) => { kind: 'weekly' | 'monthly' } | null;

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
  process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
  process.env.EVOLUTION_BASE_URL ||= 'http://127.0.0.1:8080';
  process.env.EVOLUTION_API_KEY ||= 'test';

  ({ classifyCashCorpus } = await import('../src/verticals/cash/conversation-corpus.js'));
  ({ classifyCashDeterministicLanguage } = await import('../src/verticals/cash/deterministic-language.js'));
  ({ deterministicCashParse } = await import('../src/verticals/cash/parser.js'));
  ({ deterministicCashQuery } = await import('../src/verticals/cash/query.js'));
  ({ isCashDirectBalanceRequest, isCashForecastLanguage, parseCashProjection } = await import('../src/verticals/cash/ledger.js'));
  ({ isCashNaturalRecordListRequest } = await import('../src/verticals/cash/ai-first-handler.js'));
  ({ parseCashPocketDeleteReference, parseCashPocketBalanceReference } = await import('../src/verticals/cash/pocket-context.js'));
  ({ parseCashReportRequest } = await import('../src/verticals/cash/report-context.js'));
});

const scenarios: Scenario[] = [
  { expected: 'greeting', variants: ['oi', 'olá', 'bom dia', 'e aí', 'opa'] },
  { expected: 'acknowledgement', variants: ['valeu', 'beleza', 'show', 'perfeito', 'entendi'] },
  { expected: 'transaction', variants: ['gastei 35 no mercado', 'paguei 22 no uber', 'comprei almoço por 28', 'gastei 19 na padaria', 'paguei 70 de gasolina'] },
  { expected: 'transaction', variants: ['recebi 1200 de salário', 'ganhei 350 num freela', 'entrou 90 de uma venda', 'faturei 500 hoje', 'recebi pix de 140'] },
  { expected: 'transaction', variants: ['mercado 50', 'farmácia 45', 'uber 23', 'padaria 18,50', 'gasolina 100'] },
  { expected: 'transaction', variants: ['ontem gastei 80 no mercado', 'anteontem paguei 42 na farmácia', 'hoje recebi 300', 'ontem comprei uma camisa de 79', 'hoje gastei 25 no almoço'] },
  { expected: 'transaction', variants: ['gastei 86 reais no mercado porque precisei comprar arroz feijão leite e algumas coisas para casa', 'paguei 135 na farmácia pelos remédios da semana', 'comprei uma blusa na shein por 49,90 e foi um gasto pessoal', 'recebi 750 reais de um trabalho freelance que finalizei ontem', 'gastei 120 de gasolina para trabalhar durante a semana'] },
  { expected: 'batch_transaction', variants: ['gastei 50 no mercado; paguei 20 no uber', 'recebi 300 de freela; gastei 40 no almoço', 'gastei 15 na padaria\ngastei 30 na farmácia', 'recebi 500 de venda\nrecebi 200 de freela', 'gastei 100 de gasolina; comprei almoço por 35'] },
  { expected: 'balance', variants: ['saldo', 'meu saldo', 'quanto eu tenho?', 'quanto tenho', 'quanto sobrou?'] },
  { expected: 'balance', variants: ['quanto eu tenho no total?', 'quanto tenho de dinheiro?', 'me fala meu saldo atual', 'mostra meu saldo agora', 'quanto me resta?'] },
  { expected: 'query', variants: ['quanto gastei hoje?', 'quanto paguei hoje?', 'me mostra meus gastos hoje', 'quais despesas tive hoje?', 'gastos de hoje'] },
  { expected: 'query', variants: ['quanto gastei ontem?', 'me mostra as despesas de ontem', 'quais compras fiz ontem?', 'gastos ontem', 'quanto saiu ontem?'] },
  { expected: 'query', variants: ['quanto recebi esse mês?', 'minhas receitas este mês', 'entradas desse mês', 'quanto ganhei no mês atual?', 'me mostra os recebimentos deste mês'] },
  { expected: 'query', variants: ['quanto gastei na shein hoje?', 'me mostra gastos no mercado hoje', 'quanto paguei no uber hoje?', 'despesas na farmácia hoje', 'compras na padaria hoje'] },
  { expected: 'query', variants: ['despesas acima de 100 reais', 'mostra gastos acima de 50', 'gastos abaixo de 30', 'despesas entre 20 e 80', 'compras acima de 200 hoje'] },
  { expected: 'query', variants: ['me mostra os maiores gastos hoje', 'qual foi meu maior gasto hoje?', 'maiores despesas do mês', 'menores gastos hoje', 'qual foi a compra mais cara hoje?'] },
  { expected: 'history', variants: ['meus registros', 'fala meus registros aí', 'me mostra meus lançamentos', 'quais são meus registros', 'lista meus registros pra mim'] },
  { expected: 'weekly_report', variants: ['relatório semanal', 'resumo da semana', 'como foi a semana', 'fechamento semanal', 'me manda o relatório da semana'] },
  { expected: 'monthly_report', variants: ['relatório mensal', 'resumo do mês', 'como foi o mês', 'fechamento mensal', 'me manda o relatório do mês'] },
  { expected: 'weekly_report', variants: ['relatório da semana passada', 'resumo da última semana', 'fechamento da semana anterior', 'me manda o resumo da semana passada', 'como foi a semana passada'] },
  { expected: 'monthly_report', variants: ['relatório do mês passado', 'resumo do último mês', 'fechamento do mês anterior', 'me manda o resumo do mês passado', 'como foi o mês passado'] },
  { expected: 'help', variants: ['ajuda', 'como usa isso?', 'o que você faz?', 'me ensina a usar', 'quais comandos eu posso mandar?'] },
  { expected: 'plans', variants: ['planos', 'quanto custa?', 'qual o preço do cash?', 'quero assinar', 'como pago o arles cash?'] },
  { expected: 'trial', variants: ['trial', 'quanto tempo dura o teste grátis?', 'quando acaba meu período gratuito?', 'quantos dias grátis eu tenho?', 'como funciona o trial?'] },
  { expected: 'categories', variants: ['categorias', 'quais categorias existem?', 'como categoriza meus gastos?', 'categoria automática', 'como você classifica minhas despesas?'] },
  { expected: 'pocket', variants: ['criar cofrinho Viagem', 'cria um cofrinho chamado Casa', 'abre um cofrinho Emergência', 'quero um cofrinho chamado Férias', 'crie o cofrinho Cartão'] },
  { expected: 'pocket', variants: ['meus cofrinhos', 'quais meus cofrinhos?', 'lista meus cofrinhos', 'mostra os cofrinhos', 'quero ver meus cofrinhos'] },
  { expected: 'pocket', variants: ['saldo do cofrinho Viagem', 'quanto tem no cofrinho Casa?', 'extrato do cofrinho Emergência', 'mostra o cofrinho Férias', 'quanto gastei no cofrinho Cartão?'] },
  { expected: 'pocket-balance', variants: ['quanto tenho nos cofrinhos?', 'saldo dos cofrinhos', 'qual o total nos cofrinhos?', 'quanto dinheiro tem nos cofrinhos?', 'mostra o saldo dos meus cofrinhos'] },
  { expected: 'pocket-balance', variants: ['e no cofrinho?', 'no cofrinho?', 'e no cofrinho', 'e quanto tem nele?', 'qual o saldo nele?'] },
  { expected: 'pocket-balance', variants: ['e neles?', 'quanto tem neles?', 'e nelas?', 'saldo neles', 'e quanto ficou neles?'] },
  { expected: 'pocket-delete', variants: ['apaga o cofrinho Viagem', 'exclui cofrinho Casa', 'remove o cofrinho Emergência', 'deleta o cofrinho Férias', 'tira o cofrinho Cartão'] },
  { expected: 'pocket-delete', variants: ['apaga ele', 'exclui esse', 'remove isso', 'tira ele por favor', 'apaga esse pfv'] },
  { expected: 'pocket-delete', variants: ['apaga eles pfv', 'exclui esses', 'remove todos eles', 'tira eles por favor', 'deleta esses aí'] },
  { expected: 'schedule', variants: ['todo dia 10 pago 300 do cartão', 'todo mês gasto 120 de internet', 'toda semana pago 50 de gasolina', 'mensalmente pago 900 de aluguel', 'a cada 30 dias pago 60 da academia'] },
  { expected: 'schedule', variants: ['todo mês recebo 3000 de salário', 'dia 5 de cada mês recebo 2500', 'mensalmente entra 500 de aluguel', 'toda semana recebo 200 de freela', 'todo dia 1 recebo 1000'] },
  { expected: 'schedule', variants: ['amanhã vou pagar 150 de luz', 'amanhã vou gastar 80 no mercado', 'daqui a 3 dias vou pagar 200', 'no dia 20 vou pagar 500 do cartão', 'amanhã vou receber 700'] },
  { expected: 'projection', variants: ['se eu gastar 50 quanto fica?', 'e se eu pagar 100 quanto sobra?', 'se eu receber 300 quanto fica meu saldo?', 'simula eu gastando 80', 'calcula se eu ganhar 500'] },
  { expected: 'projection', variants: ['tenho saldo de 1000, se eu gastar 250 quanto fica?', 'considera saldo de 500 e tira 80', 'partindo de saldo 300 se eu receber 200 quanto dá?', 'saldo 1000 menos 125 quanto fica?', 'com saldo de 2500 se eu pagar 900 quanto sobra?'] },
  { expected: 'projection', variants: ['não registra, só calcula: se eu gastar 70 quanto sobra?', 'sem registrar, se eu pagar 90 como fica?', 'é só uma simulação: gasto 100 e quanto resta?', 'apenas calcula se eu receber 200', 'só calcula meu saldo se sair 50'] },
  { expected: 'edit', variants: ['edita o último', 'corrige o registro 2', 'muda o último para 18 reais', 'altera a descrição do último', 'errei o valor do último registro'] },
  { expected: 'delete', variants: ['apaga o último lançamento', 'remove o registro 2', 'exclui esse registro', 'retira o lançamento de agora', 'deleta o último gasto'] },
  { expected: 'undo', variants: ['desfaz', 'coloca ele de novo', 'restaura o último', 'recupera o que apaguei', 'bota de novo'] },
  { expected: 'transaction', variants: ['gastei 35 no mercdo', 'paguei 22 no ubber', 'comprei almoço 28 reais msm', 'gastei 19 na padaria hj', 'paguei 70 gasosa'] },
  { expected: 'transaction', variants: ['caiu 1200 do salário', 'salário 2500', 'freela 400', 'pix recebido 180', 'recebimento 90'] },
  { expected: 'transaction', variants: ['50 mercado', '45 farmácia', '23 uber', '18,50 padaria', '100 gasolina'] },
  { expected: 'query', variants: ['quanto entrou esse mês?', 'quanto saiu esse mês?', 'me mostra tudo que entrou hoje', 'me mostra tudo que saiu hoje', 'quanto foi de entrada hoje?'] },
  { expected: 'query', variants: ['quanto gastei na semana passada?', 'quanto recebi no mês passado?', 'gastos dos últimos 7 dias', 'receitas este ano', 'despesas de agosto'] },
  { expected: 'balance', variants: ['qual é meu saldo?', 'quanto tenho disponível?', 'me diz quanto tenho', 'quanto ficou meu saldo?', 'saldo disponível'] },
  { expected: 'acknowledgement', variants: ['top', 'massa', 'fechou', 'tranquilo', 'tá bom'] }
];

function normalizedForContext(input: string): string {
  return input.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function route(input: string): Route {
  if (parseCashPocketDeleteReference(input)) return 'pocket-delete';

  const pocketBalance = parseCashPocketBalanceReference(input);
  if (pocketBalance?.kind === 'explicit-all') return 'pocket-balance';
  if (pocketBalance?.kind === 'context' && /\b(nele|nela|neles|nelas|cofrinh(?:o|os))\b/.test(normalizedForContext(input))) {
    return 'pocket-balance';
  }
  if (isCashDirectBalanceRequest(input)) return 'balance';
  if (pocketBalance) return 'pocket-balance';

  const report = parseCashReportRequest(input);
  if (report) return report.kind === 'weekly' ? 'weekly_report' : 'monthly_report';

  const deterministicLanguage = classifyCashDeterministicLanguage(input);
  if (deterministicLanguage && deterministicLanguage.intent !== 'future_data') {
    return deterministicLanguage.intent as Route;
  }

  if (isCashForecastLanguage(input)) return 'schedule';
  if (parseCashProjection(input)) return 'projection';
  if (isCashNaturalRecordListRequest(input)) return 'history';

  const corpus = classifyCashCorpus(input);
  const direct = new Set<Route>([
    'greeting', 'acknowledgement', 'transaction', 'batch_transaction', 'query', 'history',
    'balance', 'projection', 'pocket', 'schedule', 'weekly_report', 'monthly_report',
    'edit', 'delete', 'undo', 'help', 'plans', 'trial', 'categories'
  ]);
  if (direct.has(corpus.intent as Route)) return corpus.intent as Route;

  if (deterministicCashQuery(input)) return 'query';
  if (deterministicCashParse(input)) return 'transaction';
  return 'ai-fallback';
}

function personaMessage(persona: number, scenario: Scenario, scenarioIndex: number): string {
  const base = scenario.variants[(persona + scenarioIndex) % scenario.variants.length]!;
  // Pequenas diferenças de pontuação/cortesia sem destruir o sentido da frase.
  if (persona % 10 === 1 && !/[?!.]$/.test(base)) return `${base}!`;
  if (persona % 10 === 2 && /\?$/.test(base)) return base.replace(/\?$/, '??');
  if (persona % 10 === 3 && base.length > 18 && !/^por favor/i.test(base)) return `${base} por favor`;
  if (persona % 10 === 4 && base.length > 35) return base.replace(/\bpara\b/gi, 'pra');
  if (persona % 10 === 5 && base.length > 45) return `${base}, só pra eu me organizar melhor`;
  return base;
}

describe('Arles Cash — simulação sintética de uso diário com 5.000 mensagens', () => {
  it('mantém 100 pessoas x 50 mensagens sem desviar intenção crítica', () => {
    expect(scenarios).toHaveLength(50);

    const failures: Array<{ persona: number; scenario: number; expected: Route; actual: Route; message: string }> = [];
    const counts = new Map<Route, number>();
    const lengths = { short: 0, medium: 0, long: 0 };

    for (let persona = 0; persona < 100; persona += 1) {
      for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
        const scenario = scenarios[scenarioIndex]!;
        const message = personaMessage(persona, scenario, scenarioIndex);
        const actual = route(message);
        counts.set(actual, (counts.get(actual) ?? 0) + 1);

        const words = message.trim().split(/\s+/).length;
        if (words <= 4) lengths.short += 1;
        else if (words <= 12) lengths.medium += 1;
        else lengths.long += 1;

        if (actual !== scenario.expected) {
          failures.push({ persona: persona + 1, scenario: scenarioIndex + 1, expected: scenario.expected, actual, message });
        }
      }
    }

    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    console.info('[Cash5000Eval]', JSON.stringify({ total, lengths, routes: Object.fromEntries(counts), failures: failures.slice(0, 25) }, null, 2));

    expect(total).toBe(5000);
    expect(lengths.short).toBeGreaterThan(0);
    expect(lengths.medium).toBeGreaterThan(0);
    expect(lengths.long).toBeGreaterThan(0);
    expect(failures, `Falhas de intenção: ${JSON.stringify(failures.slice(0, 25), null, 2)}`).toEqual([]);
  });
});
