import type { CashNaturalLanguageExample, CashNaturalLanguageIntent } from './natural-language-corpus.js';

type PeriodExample = { text: string; canonical: string };
type Seed = { input: string; intent: CashNaturalLanguageIntent; canonical: string };

const PERIODS: PeriodExample[] = [
  { text: '', canonical: 'hoje' },
  { text: 'hoje', canonical: 'hoje' },
  { text: 'ontem', canonical: 'ontem' },
  { text: 'anteontem', canonical: 'anteontem' },
  { text: 'esta semana', canonical: 'esta semana' },
  { text: 'semana passada', canonical: 'semana passada' },
  { text: 'este mês', canonical: 'este mês' },
  { text: 'mês passado', canonical: 'mês passado' },
  { text: 'últimos 7 dias', canonical: 'últimos 7 dias' },
  { text: 'últimos 30 dias', canonical: 'últimos 30 dias' }
];

const WRAPPERS = [
  (value: string) => `por favor, ${value}`,
  (value: string) => `rapidinho, ${value}`,
  (value: string) => `me ajuda aqui: ${value}`,
  (value: string) => `uma dúvida: ${value}`
];

const EXPENSE_TOTAL_BASES = [
  'soma tudo que saiu',
  'some tudo que saiu',
  'soma o dinheiro que saiu',
  'some o dinheiro que saiu',
  'quanto saiu do meu bolso',
  'quanto eu torrei',
  'quanto torrei',
  'quanto foi embora em gastos',
  'quanto foi embora em despesas',
  'qual o total que saiu',
  'qual a soma do que saiu',
  'faz a conta de tudo que gastei',
  'faz a conta dos meus gastos',
  'calcula o total dos meus gastos',
  'calcula o total das despesas',
  'me passa a soma dos gastos',
  'me passa a soma das despesas',
  'me fala quanto deu tudo que paguei',
  'quanto deu tudo que paguei',
  'quanto eu desembolsei',
  'qual foi meu gasto total',
  'qual foi minha despesa total',
  'fecha tudo que eu gastei',
  'fecha tudo que eu paguei',
  'totaliza tudo que saiu da conta'
];

const INCOME_TOTAL_BASES = [
  'soma tudo que entrou',
  'some tudo que entrou',
  'soma o dinheiro que entrou',
  'some o dinheiro que entrou',
  'quanto entrou pra mim',
  'quanto caiu pra mim',
  'quanto caiu de dinheiro',
  'quanto eu fiz de dinheiro',
  'quanto fiz de dinheiro',
  'qual o total que entrou',
  'qual a soma do que entrou',
  'faz a conta de tudo que recebi',
  'faz a conta das minhas receitas',
  'calcula o total do que recebi',
  'calcula o total das receitas',
  'me passa a soma das entradas',
  'me passa a soma das receitas',
  'me fala quanto deu tudo que recebi',
  'quanto deu tudo que recebi',
  'quanto entrou na minha mão',
  'qual foi minha receita total',
  'qual foi minha entrada total',
  'fecha tudo que eu recebi',
  'fecha tudo que entrou',
  'totaliza tudo que entrou na conta'
];

const BOTH_TOTAL_BASES = [
  'soma tudo que entrou e tudo que saiu',
  'some tudo que entrou e tudo que saiu',
  'faz a conta do que entrou e saiu',
  'calcula quanto entrou e quanto saiu',
  'me passa entrada e saída total',
  'me fala entrada e saída total',
  'qual o total de dinheiro que entrou e saiu',
  'quanto entrou contra quanto saiu',
  'quanto entrou versus quanto saiu',
  'quanto recebi e quanto paguei',
  'quanto recebi e quanto gastei',
  'quanto ganhei e quanto saiu',
  'quanto entrou e quanto eu gastei',
  'me dá receita e despesa total',
  'me dá entradas e gastos totais',
  'fecha o que entrou e o que saiu',
  'faz o fechamento do dinheiro',
  'faz meu fechamento financeiro',
  'me passa meu fechamento financeiro',
  'resuma o que entrou e saiu',
  'resume entradas e saídas',
  'totaliza entradas e saídas',
  'totaliza receitas e despesas',
  'soma ganhos e gastos',
  'me mostra o total que entrou e o total que saiu'
];

const EXPENSE_LIST_BASES = [
  'me mostra onde gastei',
  'mostra onde meu dinheiro foi',
  'lista tudo que paguei',
  'lista tudo que gastei',
  'quero ver tudo que saiu',
  'quero ver onde gastei',
  'me manda as coisas que paguei',
  'me manda minhas despesas',
  'me passa tudo que eu gastei',
  'me passa tudo que eu paguei',
  'quais contas eu paguei',
  'quais gastos eu tive',
  'quais despesas eu tive',
  'o que saiu da minha conta',
  'o que eu comprei',
  'mostra minhas compras',
  'lista minhas compras',
  'traz tudo que saiu',
  'traz meus pagamentos',
  'quero conferir meus gastos'
];

const INCOME_LIST_BASES = [
  'me mostra de onde entrou dinheiro',
  'mostra o que entrou pra mim',
  'lista tudo que recebi',
  'lista tudo que entrou',
  'quero ver tudo que entrou',
  'quero ver o que recebi',
  'me manda as coisas que recebi',
  'me manda minhas entradas',
  'me passa tudo que eu recebi',
  'me passa tudo que entrou',
  'quais valores eu recebi',
  'quais entradas eu tive',
  'quais receitas eu tive',
  'o que entrou na minha conta',
  'o que eu ganhei',
  'mostra meus recebimentos',
  'lista meus recebimentos',
  'traz tudo que entrou',
  'traz minhas receitas',
  'quero conferir minhas entradas'
];

function periodizedWrapped(
  bases: string[],
  canonicalFor: (period: string) => string
): CashNaturalLanguageExample[] {
  const rows: CashNaturalLanguageExample[] = [];
  for (const base of bases) {
    for (const period of PERIODS) {
      const phrase = period.text ? `${base} ${period.text}` : base;
      for (const wrap of WRAPPERS) {
        rows.push({ input: wrap(phrase), intent: 'query', canonical: canonicalFor(period.canonical) });
      }
    }
  }
  return rows;
}

const FIXED_SEEDS: Seed[] = [
  ...[
    'me diz quanto tenho agora', 'quanto dinheiro tenho disponível', 'qual meu dinheiro disponível',
    'quanto ficou pra mim', 'quanto ainda tenho', 'quanto ainda sobrou', 'quanto resta na conta',
    'me fala quanto tenho na conta', 'qual meu saldo de verdade', 'me passa meu saldo',
    'quero saber meu saldo', 'quero ver meu saldo', 'quanto tenho livre', 'quanto tenho sobrando',
    'quanto dá meu saldo', 'como ficou meu dinheiro', 'qual o valor do meu saldo', 'saldo geral',
    'saldo de tudo', 'meu saldo completo'
  ].map(input => ({ input, intent: 'balance' as const, canonical: 'saldo' })),

  ...[
    'me mostra tudo que registrei', 'lista tudo que registrei', 'quero conferir meus registros',
    'me passa meu histórico', 'me manda o que registrei', 'mostra os últimos lançamentos',
    'lista os lançamentos', 'quero ver minhas movimentações', 'me traz minhas movimentações',
    'o que tem registrado', 'o que eu lancei', 'quais coisas eu lancei', 'mostra minhas anotações financeiras',
    'lista minhas anotações financeiras', 'me fala os registros', 'me diz os lançamentos',
    'cadê meus registros', 'cadê meus lançamentos', 'quero meu histórico financeiro', 'abre meu histórico'
  ].map(input => ({ input, intent: 'history' as const, canonical: 'histórico' })),

  ...[
    'me explica o cash', 'o que posso fazer aqui', 'como eu uso o cash', 'me mostra como funciona',
    'me ensina os comandos', 'o que posso te mandar', 'me dá uma ajuda', 'preciso de ajuda',
    'abre a ajuda', 'quero o menu', 'me mostra as opções', 'quais coisas você entende'
  ].map(input => ({ input, intent: 'help' as const, canonical: input })),

  ...[
    'quais são os planos', 'me mostra os planos', 'qual valor do plano', 'qual mensalidade',
    'quanto pago por mês', 'como faço pra assinar', 'quero virar assinante', 'onde eu assino',
    'me passa os preços', 'me mostra os preços', 'qual custa por mês', 'como funciona a assinatura'
  ].map(input => ({ input, intent: 'plans' as const, canonical: 'planos' })),

  ...[
    'quanto tempo tenho grátis', 'quantos dias de teste faltam', 'meu teste vai até quando',
    'quando termina o grátis', 'quando vence meu trial', 'quanto dura o período grátis',
    'quero saber do teste grátis', 'me explica o teste grátis', 'ainda estou no trial', 'meu trial está ativo'
  ].map(input => ({ input, intent: 'trial' as const, canonical: 'trial' })),

  ...[
    'quais tipos de categoria tem', 'me mostra as categorias', 'como separa por categoria',
    'como escolhe a categoria', 'quais categorias você usa', 'como organiza meus gastos',
    'como organiza minhas despesas', 'onde vejo as categorias', 'me explica as categorias', 'categorias disponíveis'
  ].map(input => ({ input, intent: 'categories' as const, canonical: 'categorias' })),

  ...[
    'quero ver os cofrinhos', 'abre meus cofrinhos', 'lista todos os cofrinhos', 'quais cofrinhos existem',
    'quanto guardei nos cofrinhos', 'quanto tem guardado nos cofrinhos', 'cria um cofrinho viagem',
    'cria um cofrinho reserva', 'abre um cofrinho emergência', 'faz um cofrinho férias',
    'saldo do cofrinho viagem', 'saldo do cofrinho reserva', 'quanto tem no cofrinho emergência',
    'mostra o saldo do cofrinho férias', 'extrato do cofrinho viagem', 'extrato do cofrinho reserva',
    'me mostra o cofrinho emergência', 'quero consultar o cofrinho férias', 'quero criar outra caixinha',
    'meus potinhos de dinheiro'
  ].map(input => ({ input, intent: 'pocket' as const, canonical: input })),

  ...[
    'desfaz isso', 'desfaz o que fiz', 'volta o que apaguei', 'traz de volta', 'recupera o último',
    'restaura o que removi', 'desfaz a exclusão', 'volta o registro', 'recoloca o lançamento', 'recupera esse lançamento'
  ].map(input => ({ input, intent: 'undo' as const, canonical: 'coloca ele de novo' })),

  ...[
    'se eu gastar 25 quanto sobra', 'se eu gastar 200 quanto fica', 'se eu pagar 45 quanto sobra',
    'se eu pagar 350 quanto resta', 'se eu receber 100 quanto fica', 'se eu receber 900 quanto dá',
    'simula gasto de 60', 'simula gasto de 250', 'simula entrada de 500', 'simula recebimento de 1200',
    'não registra calcula gasto de 90', 'não registra calcula entrada de 300', 'só simula 100 de gasto',
    'só simula 400 de entrada', 'saldo 2000 menos 750 quanto sobra'
  ].map(input => ({ input, intent: 'projection' as const, canonical: input })),

  ...[
    'todo mês pago 80 de telefone', 'todo mês pago 200 de luz', 'todo mês recebo 4000 de salário',
    'toda semana gasto 100 no mercado', 'toda sexta pago 50', 'mensalmente gasto 120 com internet',
    'mensalmente recebo 800 de aluguel', 'amanhã pago 90 de água', 'amanhã recebo 250 de venda',
    'daqui a 5 dias pago 300', 'daqui a 10 dias recebo 600', 'dia 15 de cada mês pago 500',
    'dia 1 de cada mês recebo 3000', 'todo ano pago 1000 de seguro', 'semanalmente recebo 200 de freela'
  ].map(input => ({ input, intent: 'schedule' as const, canonical: input }))
];

function wrappedFixed(seeds: Seed[]): CashNaturalLanguageExample[] {
  return seeds.flatMap(seed => WRAPPERS.map(wrap => ({
    input: wrap(seed.input),
    intent: seed.intent,
    canonical: seed.canonical
  })));
}

export const CASH_NATURAL_LANGUAGE_EXPANDED_EXAMPLES: CashNaturalLanguageExample[] = [
  ...periodizedWrapped(EXPENSE_TOTAL_BASES, period => `quanto gastei ${period}?`),
  ...periodizedWrapped(INCOME_TOTAL_BASES, period => `quanto recebi ${period}?`),
  ...periodizedWrapped(BOTH_TOTAL_BASES, period => `quanto entrou e quanto saiu ${period}?`),
  ...periodizedWrapped(EXPENSE_LIST_BASES, period => `me mostra meus gastos ${period}`),
  ...periodizedWrapped(INCOME_LIST_BASES, period => `me mostra minhas receitas ${period}`),
  ...wrappedFixed(FIXED_SEEDS)
];

function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[!?.,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const EXPANDED_INDEX = new Map<string, CashNaturalLanguageExample>();
for (const example of CASH_NATURAL_LANGUAGE_EXPANDED_EXAMPLES) {
  const key = normalize(example.input);
  if (!EXPANDED_INDEX.has(key)) EXPANDED_INDEX.set(key, example);
}

export function matchCashNaturalLanguageExpandedExample(input: string): CashNaturalLanguageExample | null {
  return EXPANDED_INDEX.get(normalize(input)) ?? null;
}

export const CASH_NATURAL_LANGUAGE_EXPANDED_EXAMPLE_COUNT = EXPANDED_INDEX.size;
