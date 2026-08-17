import { beforeAll, describe, expect, it } from 'vitest';

let classifyCashDeterministicLanguage: (input: string) => { intent: string; canonical: string } | null;
let deterministicCashQuery: (input: string) => unknown;
let examples: Array<{ input: string; intent: string; canonical: string }>;
let expandedExamples: Array<{ input: string; intent: string; canonical: string }>;
let colloquialExamples: Array<{ input: string; intent: string; canonical: string }>;
let quadrupledExamples: Array<{ input: string; intent: string; canonical: string }>;
let doubledExamples: Array<{ input: string; intent: string; canonical: string }>;
let exampleCount: number;
let expandedExampleCount: number;
let colloquialExampleCount: number;
let previousUniqueCount: number;
let currentUniqueCount: number;
let quadrupledExampleCount: number;
let preDoublingUniqueCount: number;
let doubledExampleCount: number;

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

  const quadrupled = await import('../src/verticals/cash/natural-language-corpus-quadrupled.js');
  quadrupledExamples = quadrupled.CASH_NATURAL_LANGUAGE_QUADRUPLED_EXAMPLES;
  currentUniqueCount = quadrupled.CASH_NATURAL_LANGUAGE_CURRENT_UNIQUE_COUNT;
  quadrupledExampleCount = quadrupled.CASH_NATURAL_LANGUAGE_QUADRUPLED_EXAMPLE_COUNT;

  const doubled = await import('../src/verticals/cash/natural-language-corpus-doubled.js');
  doubledExamples = doubled.CASH_NATURAL_LANGUAGE_DOUBLED_EXAMPLES;
  preDoublingUniqueCount = doubled.CASH_NATURAL_LANGUAGE_PRE_DOUBLING_UNIQUE_COUNT;
  doubledExampleCount = doubled.CASH_NATURAL_LANGUAGE_DOUBLED_EXAMPLE_COUNT;
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

  it('mantém a duplicação anterior acima de 12.000 formas únicas totais', () => {
    expect(previousUniqueCount).toBeGreaterThan(6000);
    expect(colloquialExampleCount).toBe(previousUniqueCount);
    expect(currentUniqueCount).toBeGreaterThan(12000);
  });

  it('mantém a expansão 4x anterior acima de 48.000 formas únicas totais', () => {
    expect(quadrupledExampleCount).toBe(currentUniqueCount * 3);
    expect(preDoublingUniqueCount).toBeGreaterThan(48000);
    expect(preDoublingUniqueCount).toBe(currentUniqueCount * 4);
  });

  it('dobra a capacidade de 48.000+ criando uma nova frase para cada frase única existente', () => {
    expect(doubledExampleCount).toBe(preDoublingUniqueCount);
  });

  it('mantém mais de 96.000 frases únicas somando todas as camadas', () => {
    const unique = new Set(
      [...examples, ...expandedExamples, ...colloquialExamples, ...quadrupledExamples, ...doubledExamples]
        .map(example => normalize(example.input))
    );
    expect(unique.size).toBeGreaterThan(96000);
    expect(unique.size).toBe(preDoublingUniqueCount * 2);
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

  it('classifica toda a camada coloquial anterior sem depender de IA', () => {
    const failures: Array<{ input: string; expected: string; actual: string | null }> = [];

    for (const example of colloquialExamples) {
      const route = classifyCashDeterministicLanguage(example.input);
      if (route?.intent !== example.intent) {
        failures.push({ input: example.input, expected: example.intent, actual: route?.intent ?? null });
      }
    }

    expect(failures, JSON.stringify(failures.slice(0, 100), null, 2)).toEqual([]);
  });

  it('classifica todas as formas da expansão 4x sem depender de IA', () => {
    const failures: Array<{ input: string; expected: string; actual: string | null }> = [];

    for (const example of quadrupledExamples) {
      const route = classifyCashDeterministicLanguage(example.input);
      if (route?.intent !== example.intent) {
        failures.push({ input: example.input, expected: example.intent, actual: route?.intent ?? null });
      }
    }

    expect(failures, JSON.stringify(failures.slice(0, 100), null, 2)).toEqual([]);
  });

  it('classifica todas as novas formas que dobram a capacidade para 96.000+ sem depender de IA', () => {
    const failures: Array<{ input: string; expected: string; actual: string | null }> = [];

    for (const example of doubledExamples) {
      const route = classifyCashDeterministicLanguage(example.input);
      if (route?.intent !== example.intent) {
        failures.push({ input: example.input, expected: example.intent, actual: route?.intent ?? null });
      }
    }

    expect(failures, JSON.stringify(failures.slice(0, 100), null, 2)).toEqual([]);
  });

  it('transforma todas as perguntas de soma/total em consultas válidas ao banco', () => {
    const failures: string[] = [];
    const all = [...examples, ...expandedExamples, ...colloquialExamples, ...quadrupledExamples, ...doubledExamples];
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

  it('aceita amostras reais espalhadas pela nova camada que dobra para 96.000+', () => {
    const indexes = [
      0,
      Math.floor(doubledExamples.length / 8),
      Math.floor(doubledExamples.length / 4),
      Math.floor((doubledExamples.length * 3) / 8),
      Math.floor(doubledExamples.length / 2),
      Math.floor((doubledExamples.length * 5) / 8),
      Math.floor((doubledExamples.length * 3) / 4),
      Math.floor((doubledExamples.length * 7) / 8),
      doubledExamples.length - 1
    ];

    for (const index of indexes) {
      const example = doubledExamples[index];
      expect(example).toBeDefined();
      const route = classifyCashDeterministicLanguage(example!.input);
      expect(route?.intent).toBe(example!.intent);
      expect(route?.canonical).toBe(example!.canonical);
    }
  });
});
