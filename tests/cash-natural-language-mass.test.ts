import { beforeAll, describe, expect, it } from 'vitest';

let classifyCashDeterministicLanguage: (input: string) => { intent: string; canonical: string } | null;
let deterministicCashQuery: (input: string) => unknown;
let examples: Array<{ input: string; intent: string; canonical: string }>;
let exampleCount: number;

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
});

describe('Arles Cash — linguagem natural determinística em massa', () => {
  it('mantém mais de 1.500 formas humanas de falar no corpus', () => {
    expect(exampleCount).toBeGreaterThan(1500);
  });

  it('classifica todo o corpus sem depender de IA', () => {
    const failures: Array<{ input: string; expected: string; actual: string | null }> = [];

    for (const example of examples) {
      const route = classifyCashDeterministicLanguage(example.input);
      if (route?.intent !== example.intent) {
        failures.push({ input: example.input, expected: example.intent, actual: route?.intent ?? null });
      }
    }

    expect(failures, JSON.stringify(failures.slice(0, 50), null, 2)).toEqual([]);
  });

  it('transforma todas as perguntas de soma/total em consultas válidas ao banco', () => {
    const failures: string[] = [];
    for (const example of examples.filter(item => item.intent === 'query')) {
      const route = classifyCashDeterministicLanguage(example.input);
      if (!route || !deterministicCashQuery(route.canonical)) failures.push(example.input);
    }
    expect(failures, JSON.stringify(failures.slice(0, 50), null, 2)).toEqual([]);
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
    'me mostra quanto entrou quanto saiu e quanto sobrou'
  ])('generaliza além das frases exatas do corpus: %s', input => {
    const route = classifyCashDeterministicLanguage(input);
    expect(route?.intent).toBe('query');
    expect(deterministicCashQuery(route!.canonical)).not.toBeNull();
  });
});
