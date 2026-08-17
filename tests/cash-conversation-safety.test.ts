import { beforeAll, describe, expect, it } from 'vitest';

let normalizeCashNoisyLanguage: (input: string) => string;
let parseCashMultiIntent: (input: string) => { primary: string; secondary: string } | null;
let canonicalCashDeferredQuery: (input: string) => string | null;
let expandCashQueryContext: (previous: string, current: string) => string | null;
let isCashVagueDestructiveReference: (input: string) => boolean;
let isCashAmbiguousCalculationRemoval: (input: string) => boolean;

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
  process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
  process.env.EVOLUTION_BASE_URL ||= 'http://127.0.0.1:8080';
  process.env.EVOLUTION_API_KEY ||= 'test';

  const safety = await import('../src/verticals/cash/conversation-safety.js');
  normalizeCashNoisyLanguage = safety.normalizeCashNoisyLanguage;
  parseCashMultiIntent = safety.parseCashMultiIntent;
  canonicalCashDeferredQuery = safety.canonicalCashDeferredQuery;
  expandCashQueryContext = safety.expandCashQueryContext;
  isCashVagueDestructiveReference = safety.isCashVagueDestructiveReference;
  isCashAmbiguousCalculationRemoval = safety.isCashAmbiguousCalculationRemoval;
});

describe('Arles Cash — proteção conversacional', () => {
  it.each([
    ['qnt q saiu esse mes pq acho q to gastano mt', 'quanto que saiu esse mes pq acho que to gastando muito'],
    ['gstei 50 no mercado hj', 'gastei 50 no mercado hoje'],
    ['pguei 80 de gasolina agr', 'paguei 80 de gasolina agora'],
    ['rcebi 1200 hj', 'recebi 1200 hoje'],
    ['qto eu gasteii esse mes', 'quanto eu gastei esse mes'],
    ['Q Burger 50', 'Q Burger 50']
  ])('normaliza ruído sem estragar nomes: %s', (input, expected) => {
    expect(normalizeCashNoisyLanguage(input)).toBe(expected);
  });

  it.each([
    ['gastei 50 de gasolina e me diz quanto ainda tenho', 'gastei 50 de gasolina', 'quanto ainda tenho'],
    ['recebi 1000 e quanto sobrou?', 'recebi 1000', 'quanto sobrou?'],
    ['paguei 80 no mercado; me fala quanto gastei hoje', 'paguei 80 no mercado', 'quanto gastei hoje'],
    ['comprei remédio 35, quero saber quanto ainda tenho', 'comprei remédio 35', 'quanto ainda tenho']
  ])('separa lançamento + consulta: %s', (input, primary, secondary) => {
    expect(parseCashMultiIntent(input)).toEqual({ primary, secondary });
  });

  it.each([
    'gastei 50 e obrigado',
    'quanto gastei hoje e ontem?',
    'saldo e histórico'
  ])('não inventa múltipla intenção quando não é lançamento + consulta: %s', input => {
    expect(parseCashMultiIntent(input)).toBeNull();
  });

  it('canoniza a segunda intenção sem transformar qualquer texto em consulta', () => {
    expect(canonicalCashDeferredQuery('quanto ainda tenho')).toBe('saldo');
    expect(canonicalCashDeferredQuery('me mostra meu saldo')).toBe('saldo');
    expect(canonicalCashDeferredQuery('quanto gastei hoje?')).toBe('quanto gastei hoje?');
    expect(canonicalCashDeferredQuery('manda um pix')).toBeNull();
  });

  it.each([
    ['quanto gastei este mês?', 'e mês passado?', 'quanto gastei mês passado'],
    ['quanto gastei este mês?', 'e só com alimentação?', 'quanto gastei este mês só com alimentação'],
    ['quanto gastei este mês?', 'e na SHEIN?', 'quanto gastei este mês na SHEIN'],
    ['quanto gastei este mês?', 'e acima de 100?', 'quanto gastei este mês acima de 100'],
    ['quanto gastei este mês?', 'e entradas?', 'quanto recebi este mês?'],
    ['quanto gastei este mês?', 'e o maior?', 'quanto gastei este mês maior gasto']
  ])('expande contexto curto: %s + %s', (previous, current, expected) => {
    expect(expandCashQueryContext(previous, current)).toBe(expected);
  });

  it('não reaproveita contexto para conversa sem filtro financeiro', () => {
    expect(expandCashQueryContext('quanto gastei este mês?', 'e você?')).toBeNull();
    expect(expandCashQueryContext('quanto gastei este mês?', 'me explica como funciona o produto')).toBeNull();
  });

  it.each([
    'apaga esse',
    'remove isso',
    'cancela ele na verdade',
    'edita essa',
    'corrige ele por favor'
  ])('marca referência destrutiva vaga: %s', input => {
    expect(isCashVagueDestructiveReference(input)).toBe(true);
  });

  it.each([
    'apaga o 2',
    'apaga o último registro',
    'edita o registro 3',
    'remove a conta de luz de 80 reais'
  ])('não bloqueia alvo explícito: %s', input => {
    expect(isCashVagueDestructiveReference(input)).toBe(false);
  });

  it.each([
    'tira o mercado daí',
    'desconsidera alimentação desse total',
    'remove a SHEIN dessa soma',
    'retira gasolina do total'
  ])('bloqueia exclusão ambígua de cálculo: %s', input => {
    expect(isCashAmbiguousCalculationRemoval(input)).toBe(true);
  });

  it('permite exclusão explicitamente endereçada', () => {
    expect(isCashAmbiguousCalculationRemoval('apaga o registro 2')).toBe(false);
  });
});
