export type CashNaturalLanguageIntent =
  | 'balance'
  | 'projection'
  | 'schedule'
  | 'query'
  | 'history'
  | 'help'
  | 'plans'
  | 'trial'
  | 'categories'
  | 'pocket'
  | 'undo';

export type CashNaturalLanguageExample = {
  input: string;
  intent: CashNaturalLanguageIntent;
  canonical: string;
};

type PeriodExample = { text: string; canonical: string };

const PERIODS: PeriodExample[] = [
  { text: '', canonical: 'hoje' },
  { text: 'hoje', canonical: 'hoje' },
  { text: 'ontem', canonical: 'ontem' },
  { text: 'anteontem', canonical: 'anteontem' },
  { text: 'este mês', canonical: 'este mês' },
  { text: 'mês passado', canonical: 'mês passado' },
  { text: 'esta semana', canonical: 'esta semana' },
  { text: 'semana passada', canonical: 'semana passada' }
];

const EXPENSE_TOTAL_BASES = [
  'some o que eu gastei',
  'some o que gastei',
  'soma tudo que eu gastei',
  'soma meus gastos',
  'some meus gastos',
  'some as despesas',
  'soma as despesas',
  'qual o total dos meus gastos',
  'qual foi o total dos meus gastos',
  'me diga o total que eu gastei',
  'me fala o total que eu gastei',
  'quanto eu gastei no total',
  'quanto gastei no total',
  'totaliza minhas despesas',
  'total das minhas despesas',
  'quanto deu de despesa',
  'quanto deu de gastos',
  'quanto saiu',
  'quanto saiu no total',
  'qual foi o total de saída',
  'qual o total das saídas',
  'me fala o total das saídas',
  'me diga quanto saiu',
  'me fala quanto saiu',
  'me manda o total dos gastos',
  'me mande o total dos gastos',
  'me passa o total das despesas',
  'quanto eu paguei ao todo',
  'quanto paguei ao todo',
  'quanto foi embora',
  'quanto saiu da conta',
  'qual o total das compras',
  'qual foi o total das compras',
  'me dê a soma das despesas',
  'faz a soma do que eu gastei',
  'faça a soma do que eu gastei',
  'some meus lançamentos de despesa',
  'soma meus lançamentos de gasto',
  'total de gastos',
  'total de despesas',
  'total de saídas',
  'soma do que saiu',
  'soma do que eu paguei',
  'some tudo que saiu',
  'quanto deu tudo que eu gastei',
  'quanto deu o que eu gastei',
  'qual a soma do que gastei',
  'qual a soma dos gastos',
  'fecha meus gastos',
  'fecha minhas despesas'
];

const INCOME_TOTAL_BASES = [
  'some o que eu ganhei',
  'some o que ganhei',
  'soma tudo que eu ganhei',
  'soma minhas receitas',
  'some minhas receitas',
  'some as entradas',
  'soma as entradas',
  'qual o total do que eu ganhei',
  'qual foi o total do que eu ganhei',
  'me diga o total que eu recebi',
  'me fala o total que eu recebi',
  'quanto eu ganhei no total',
  'quanto ganhei no total',
  'totaliza minhas receitas',
  'total das minhas receitas',
  'quanto deu de receita',
  'quanto deu de entrada',
  'quanto entrou',
  'quanto entrou no total',
  'qual foi o total de entrada',
  'qual o total das entradas',
  'me fala o total das entradas',
  'me diga quanto entrou',
  'me fala quanto entrou',
  'me manda o total das receitas',
  'me mande o total das receitas',
  'me passa o total das entradas',
  'quanto eu recebi ao todo',
  'quanto recebi ao todo',
  'quanto caiu pra mim',
  'quanto caiu na conta',
  'qual o total das vendas',
  'qual foi o total das vendas',
  'me dê a soma das receitas',
  'faz a soma do que eu recebi',
  'faça a soma do que eu recebi',
  'some meus lançamentos de receita',
  'soma meus lançamentos de entrada',
  'total de receitas',
  'total de entradas',
  'total de ganhos',
  'soma do que entrou',
  'soma do que eu recebi',
  'some tudo que entrou',
  'quanto deu tudo que eu ganhei',
  'quanto deu o que eu recebi',
  'qual a soma do que ganhei',
  'qual a soma das entradas',
  'fecha minhas receitas',
  'fecha minhas entradas'
];

const BOTH_TOTAL_BASES = [
  'me mande o valor total de tudo quanto eu ganhei e quanto eu gastei',
  'me manda o valor total de tudo quanto eu ganhei e quanto eu gastei',
  'some o valor dos lançamentos referente ao que eu ganhei e que eu gastei',
  'soma o valor dos lançamentos referente ao que eu ganhei e que eu gastei',
  'some o que eu ganhei e o que eu gastei',
  'soma o que eu ganhei e o que eu gastei',
  'quanto eu ganhei e quanto eu gastei',
  'quanto ganhei e quanto gastei',
  'quanto entrou e quanto saiu',
  'me diga quanto entrou e quanto saiu',
  'me fala quanto entrou e quanto saiu',
  'me manda quanto entrou e quanto saiu',
  'me mostre o total de entradas e saídas',
  'mostra o total de entradas e saídas',
  'total de entradas e saídas',
  'total de receitas e despesas',
  'soma receitas e despesas',
  'some receitas e despesas',
  'soma entradas e saídas',
  'some entradas e saídas',
  'qual o total do que entrou e saiu',
  'qual foi o total do que entrou e saiu',
  'quanto deu de entrada e saída',
  'quanto deu de receita e despesa',
  'me passa o total do que ganhei e gastei',
  'me passe o total do que ganhei e gastei',
  'me dá o total do que ganhei e gastei',
  'me de o total do que ganhei e gastei',
  'me dê o total do que ganhei e gastei',
  'quero o total do que ganhei e gastei',
  'quero saber quanto entrou e saiu',
  'quero saber o total de ganhos e gastos',
  'fecha entradas e saídas',
  'fecha receitas e despesas',
  'fecha tudo que entrou e saiu',
  'faz um fechamento de entradas e saídas',
  'faça um fechamento de entradas e saídas',
  'me dá o fechamento do que entrou e saiu',
  'balanço do que entrou e saiu',
  'balanco do que entrou e saiu',
  'resumo do que eu ganhei e gastei',
  'resumo de entradas e saídas',
  'resumo de receitas e despesas',
  'me diga o total dos lançamentos de entrada e saída',
  'some meus lançamentos de entrada e saída',
  'some todos os lançamentos de receita e despesa',
  'quanto foi de ganho e de gasto',
  'quanto foi de entrada e de saída',
  'quanto tive de receita e despesa',
  'quanto tive de entrada e saída',
  'me mostra quanto entrou quanto saiu e quanto sobrou',
  'me diga quanto ganhei quanto gastei e quanto sobrou',
  'total geral de ganhos e gastos',
  'total geral de entradas e saídas',
  'soma geral das receitas e despesas'
];

const EXPENSE_LIST_BASES = [
  'me mostra meus gastos', 'mostra minhas despesas', 'lista meus gastos', 'liste minhas despesas',
  'quais foram meus gastos', 'quais despesas eu tive', 'o que eu gastei', 'o que eu paguei',
  'me manda meus gastos', 'me passe as despesas', 'quero ver os gastos', 'quero ver as despesas',
  'traz meus gastos', 'traga minhas despesas', 'mostra tudo que saiu', 'lista tudo que saiu'
];

const INCOME_LIST_BASES = [
  'me mostra minhas receitas', 'mostra minhas entradas', 'lista minhas receitas', 'liste minhas entradas',
  'quais foram minhas receitas', 'quais entradas eu tive', 'o que eu ganhei', 'o que eu recebi',
  'me manda minhas receitas', 'me passe as entradas', 'quero ver as receitas', 'quero ver as entradas',
  'traz minhas receitas', 'traga minhas entradas', 'mostra tudo que entrou', 'lista tudo que entrou'
];

function periodized(bases: string[], intent: CashNaturalLanguageIntent, canonicalFor: (period: string) => string): CashNaturalLanguageExample[] {
  return bases.flatMap(base => PERIODS.map(period => ({
    input: period.text ? `${base} ${period.text}` : base,
    intent,
    canonical: canonicalFor(period.canonical)
  })));
}

const FIXED: CashNaturalLanguageExample[] = [
  ...['saldo', 'meu saldo', 'qual meu saldo', 'quanto tenho', 'quanto eu tenho', 'quanto sobrou', 'quanto me resta', 'quanto tenho disponível', 'me fala meu saldo', 'me mostra meu saldo', 'me diz meu saldo', 'qual é meu saldo atual', 'quanto tenho de dinheiro', 'como está meu saldo', 'quanto ficou meu saldo', 'saldo disponível', 'saldo atual', 'quanto tem na conta', 'quanto eu tenho agora', 'meu dinheiro agora'].map(input => ({ input, intent: 'balance' as const, canonical: 'saldo' })),
  ...['meus registros', 'meus lançamentos', 'minhas movimentações', 'lista meus registros', 'mostra meus registros', 'me mostra meus lançamentos', 'quais meus registros', 'quais são meus lançamentos', 'o que registrei', 'o que eu registrei', 'histórico', 'historico', 'me manda meu histórico', 'me mostre minhas movimentações', 'lista as movimentações', 'traz meus registros', 'fala meus registros aí', 'quero ver meus lançamentos', 'quero ver o que registrei', 'mostra o histórico'].map(input => ({ input, intent: 'history' as const, canonical: 'histórico' })),
  ...['ajuda', 'me ajuda', 'como usa', 'como usar', 'como funciona', 'o que você faz', 'o que da pra fazer', 'o que dá pra fazer', 'me ensina', 'quais comandos', 'mostra o menu', 'menu', 'tutorial'].map(input => ({ input, intent: 'help' as const, canonical: input })),
  ...['planos', 'qual o preço', 'quanto custa', 'quanto custa o cash', 'quero assinar', 'como assino', 'quero pagar', 'como pago o cash', 'preço do plano', 'valor da assinatura', 'assinatura', 'plano do cash'].map(input => ({ input, intent: 'plans' as const, canonical: 'planos' })),
  ...['trial', 'teste grátis', 'teste gratis', 'quanto dura o teste', 'quantos dias grátis', 'quando acaba meu teste', 'período gratuito', 'periodo gratuito', 'como funciona o trial', 'dias de teste'].map(input => ({ input, intent: 'trial' as const, canonical: 'trial' })),
  ...['categorias', 'quais categorias', 'como categoriza', 'como você categoriza', 'categoria automática', 'classifica meus gastos', 'classifica minhas despesas', 'como classifica as despesas'].map(input => ({ input, intent: 'categories' as const, canonical: 'categorias' })),
  ...['meus cofrinhos', 'quais meus cofrinhos', 'lista meus cofrinhos', 'mostra meus cofrinhos', 'quero ver meus cofrinhos', 'saldo dos cofrinhos', 'quanto tenho nos cofrinhos', 'criar cofrinho viagem', 'cria cofrinho casa', 'abre um cofrinho emergência', 'quero criar um cofrinho', 'quanto tem no cofrinho viagem', 'extrato do cofrinho casa', 'mostra o cofrinho férias'].map(input => ({ input, intent: 'pocket' as const, canonical: input })),
  ...['desfaz', 'desfazer', 'coloca de novo', 'bota de novo', 'põe de novo', 'poe de novo', 'restaura o último', 'recupera o que apaguei', 'volta o último lançamento', 'traz de volta o registro'].map(input => ({ input, intent: 'undo' as const, canonical: 'coloca ele de novo' })),
  ...['se eu gastar 50 quanto sobra', 'se eu pagar 100 quanto fica', 'se eu receber 300 quanto fica meu saldo', 'simula eu gastando 80', 'simula eu recebendo 500', 'só calcula se eu gastar 70', 'não registra só calcula se eu pagar 90', 'saldo 1000 menos 200 quanto fica', 'saldo 500 mais 100 quanto dá', 'considera saldo de 500 e tira 80'].map(input => ({ input, intent: 'projection' as const, canonical: input })),
  ...['todo mês pago 100 de internet', 'todo dia 10 pago 300 do cartão', 'toda semana gasto 50 de gasolina', 'mensalmente pago 900 de aluguel', 'todo mês recebo 3000 de salário', 'dia 5 de cada mês recebo 2500', 'amanhã vou pagar 150 de luz', 'amanhã vou receber 700', 'daqui a 3 dias vou pagar 200', 'no dia 20 vou pagar 500 do cartão'].map(input => ({ input, intent: 'schedule' as const, canonical: input }))
];

export const CASH_NATURAL_LANGUAGE_EXAMPLES: CashNaturalLanguageExample[] = [
  ...periodized(EXPENSE_TOTAL_BASES, 'query', period => `quanto gastei ${period}?`),
  ...periodized(INCOME_TOTAL_BASES, 'query', period => `quanto recebi ${period}?`),
  ...periodized(BOTH_TOTAL_BASES, 'query', period => `quanto entrou e quanto saiu ${period}?`),
  ...periodized(EXPENSE_LIST_BASES, 'query', period => `me mostra meus gastos ${period}`),
  ...periodized(INCOME_LIST_BASES, 'query', period => `me mostra minhas receitas ${period}`),
  ...FIXED
];

function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[!?.,;:]+$/g, '')
    .replace(/\s+(?:por favor|pfv)$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const EXAMPLE_INDEX = new Map<string, CashNaturalLanguageExample>();
for (const example of CASH_NATURAL_LANGUAGE_EXAMPLES) {
  const key = normalize(example.input);
  if (!EXAMPLE_INDEX.has(key)) EXAMPLE_INDEX.set(key, example);
}

export function matchCashNaturalLanguageExample(input: string): CashNaturalLanguageExample | null {
  return EXAMPLE_INDEX.get(normalize(input)) ?? null;
}

export const CASH_NATURAL_LANGUAGE_EXAMPLE_COUNT = EXAMPLE_INDEX.size;
