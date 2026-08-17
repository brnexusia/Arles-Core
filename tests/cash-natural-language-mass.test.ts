import { beforeAll, describe, expect, it } from 'vitest';

let classifyCashDeterministicLanguage: (input: string) => { intent: string; canonical: string } | null;
let deterministicCashQuery: (input: string) => unknown;
let examples: Array<{ input: string; intent: string; canonical: string }>;
let expandedExamples: Array<{ input: string; intent: string; canonical: string }>;
let colloquialExamples: Array<{ input: string; intent: string; canonical: string }>;
let exampleCount: number;
let expandedExampleCount: number;
let colloquialExampleCount: number;
let previousUniqueCount: number;

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
  process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
  process.env.EVOLUTION_BASE_URL ||= 'http://127.0.0.1:8080';
  process.env.EVOLUTION_API_KEY ||= 'test';

  ({ classifyCashDeterministicLanguage } = await import('../src/verticals/cash/deterministic-language.js'));
  ({ deterministicCashQuery } = await import('../src/verticals/cash/query.js'));

  const corpus = await import('../src/verticals/cash/natural-language-corpus.js');
  examples = corpus.CASH_NATURAL_LANGUAGE_EXAMPLES;
  exampleCount = corpus.CASH_NATURAL_LANGUAGE_EXAMPLE_COUNT;

  const expanded = await import('../src/verticals/cash/natural-language-corpus-expanded.js');
  expandedExamples = expanded.CASH_NATURAL_LANGUAGE_EXPANDED_EXAMPLES;
  expandedExampleCount = expanded.CASH_NATURAL_LANGUAGE_EXPANDED_EXAMPLE_COUNT;

  const colloquial = await import('../src/verticals/cash/natural-language-corpus-colloquial.js');
  colloquialExamples = colloquial.CASH_NATURAL_LANGUAGE_COLLOQUIAL_EXAMPLES;
  colloquialExampleCount = colloquial.CASH_NATURAL_LANGUAGE_COLLOQUIAL_EXAMPLE_COUNT;
  previousUniqueCount = colloquial.CASH_NATURAL_LANGUAGE_PREVIOUS_UNIQUE_COUNT;
});

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

describe('Arles Cash — linguagem natural determinística em massa', () => {
  it('mantém o corpus original acima de 1.500 formas humanas', () => {
    expect(exampleCount).toBeGreaterThan(1500);
  });

  it('mantém mais de 4.500 formas na primeira expansão', () => {
    expect(expandedExampleCount).toBeGreaterThan(4500);
  });

  it('dobra a capacidade anterior com uma nova frase para cada frase única já existente', () => {
    expect(previousUniqueCount).toBeGreaterThan(6000);
    expect(colloquialExampleCount).toBe(previousUniqueCount);
  });

  it('mantém mais de 12.000 frases únicas somando todas as camadas', () => {
    const unique = new Set(
      [...examples, ...expandedExamples, ...colloquialExamples].map(example => normalize(example.input))
    );
    expect(unique.size).toBeGreaterThan(12000);
  });

  it('classifica todo o corpus original sem depender de IA', () => {
    const failures: Array<{ input: string; expected: string; actual: string | null }> = [];

    for (const example of examples) {
      const route = classifyCashDeterministicLanguage(example.input);
      if (route?.intent !== example.intent) {
        failures.push({ input: example.input, expected: example.intent, actual: route?.intent ?? null });
      }
    }

    expect(failures, JSON.stringify(failures.slice(0, 50), null, 2)).toEqual([]);
  });

  it('classifica toda a primeira expansão sem depender de IA', () => {
    const failures: Array<{ input: string; expected: string; actual: string | null }> = [];

    for (const example of expandedExamples) {
      const route = classifyCashDeterministicLanguage(example.input);
      if (route?.intent !== example.intent) {
        failures.push({ input: example.input, expected: example.intent, actual: route?.intent ?? null });
      }
    }

    expect(failures, JSON.stringify(failures.slice(0, 100), null, 2)).toEqual([]);
  });

  it('classifica toda a nova camada coloquial que dobra a capacidade sem depender de IA', () => {
    const failures: Array<{ input: string; expected: string; actual: string | null }> = [];

    for (const example of colloquialExamples) {
      const route = classifyCashDeterministicLanguage(example.input);
      if (route?.intent !== example.intent) {
        failures.push({ input: example.input, expected: example.intent, actual: route?.intent ?? null });
      }
    }

    expect(failures, JSON.stringify(failures.slice(0, 100), null, 2)).toEqual([]);
  });

  it('transforma todas as perguntas de soma/total em consultas válidas ao banco', () => {
    const failures: string[] = [];
    const all = [...examples, ...expandedExamples, ...colloquialExamples];
    for (const example of all.filter(item => item.intent === 'query')) {
      const route = classifyCashDeterministicLanguage(example.input);
      if (!route || !deterministicCashQuery(route.canonical)) failures.push(example.input);
    }
    expect(failures, JSON.stringify(failures.slice(0, 100), null, 2)).toEqual([]);
  });

  it.each([
    ['Me mande o valor total de tudo quanto eu ganhei e quanto eu gastei', 'quanto entrou e quanto saiu hoje?'],
    ['Some o valor dos lançamentos referente ao que eu ganhei e que eu gastei', 'quanto entrou e quanto saiu hoje?'],
    ['some o que gastei', 'quanto gastei hoje?'],
    ['soma tudo que recebi', 'quanto recebi hoje?'],
    ['qual o total de entradas e saídas este mês', 'quanto entrou e quanto saiu este mês?'],
    ['por favor some minhas despesas ontem', 'quanto gastei ontem?'],
    ['me fala o total do que ganhei semana passada', 'quanto recebi semana passada?'],
    ['quanto entrou e quanto saiu em agosto', 'quanto entrou e quanto saiu agosto?']
  ])('entende agregação natural: %s', (input, canonical) => {
    const route = classifyCashDeterministicLanguage(input);
    expect(route?.intent).toBe('query');
    expect(route?.canonical).toBe(canonical);
    expect(deterministicCashQuery(route!.canonical)).not.toBeNull();
  });

  it.each([
    'consegue somar tudo que eu gastei hoje?',
    'pode somar pra mim o que eu recebi este mês?',
    'me diga o total do que entrou e saiu ontem',
    'faz o total das despesas da semana passada',
    'quanto foi de receita e despesa hoje',
    'me passa a soma de entradas e saídas deste mês',
    'quero saber quanto eu ganhei e quanto eu gastei hoje',
    'qual foi o total dos meus pagamentos ontem',
    'soma os lançamentos de receita e despesa',
    'me mostra quanto entrou quanto saiu e quanto sobrou',
    'rapidinho, soma tudo que saiu este mês',
    'uma dúvida: quanto entrou pra mim nos últimos 30 dias',
    'me ajuda aqui: lista tudo que paguei ontem',
    'por favor, me mostra de onde entrou dinheiro esta semana'
  ])('generaliza além das frases exatas dos corpus: %s', input => {
    const route = classifyCashDeterministicLanguage(input);
    expect(route?.intent).toBe('query');
    expect(deterministicCashQuery(route!.canonical)).not.toBeNull();
  });

  it.each([
    'seguinte, saldo',
    'ó, me mostra meus gastos hoje',
    'só uma coisa: quanto entrou e quanto saiu hoje',
    'pra eu conferir, meus registros',
    'quando puder, meus cofrinhos',
    'faz um favor, planos'
  ])('aceita novas formas coloquiais da camada dobrada: %s', input => {
    expect(classifyCashDeterministicLanguage(input)).not.toBeNull();
  });
});
