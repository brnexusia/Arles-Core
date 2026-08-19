import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

let cashBatchSectionCue: (input: string) => 'income' | 'expense' | null;
let cashFinancialAmountTokens: (input: string) => string[];
let fallbackBatch: (input: string) => Promise<Array<{
  type: 'income' | 'expense';
  amount: number;
  category: string;
  description: string;
  transactionDate: string;
}>>;
let isCashNonRealBatchSegment: (input: string) => boolean;
let looksLikeCashBatch: (input: string) => boolean;
let selectCashBatchTransactions: (
  ai: Array<any>,
  deterministic: Array<any>
) => Array<any>;

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
  process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
  process.env.EVOLUTION_BASE_URL ||= 'http://127.0.0.1:8080';
  process.env.EVOLUTION_API_KEY ||= 'test';

  ({
    cashBatchSectionCue,
    cashFinancialAmountTokens,
    fallbackBatch,
    isCashNonRealBatchSegment,
    looksLikeCashBatch,
    selectCashBatchTransactions
  } = await import('../src/verticals/cash/smart-input.js'));
});

describe('Cash resilient batch interpretation', () => {
  it('does not confuse dates, times, percentages, years or duration counts with money', () => {
    const input = 'Em 31/07/2026 às 15:30 houve reajuste de 5% por 18 meses e recebi R$ 100,00.';
    expect(cashFinancialAmountTokens(input)).toEqual(['R$ 100,00']);
    expect(looksLikeCashBatch(input)).toBe(false);
  });

  it.each([
    ['Bom, eu ganhei hoje', 'income'],
    ['Hoje entrou dinheiro', 'income'],
    ['Minhas receitas foram:', 'income'],
    ['Recebimentos de hoje:', 'income'],
    ['E gastei algumas coisas', 'expense'],
    ['Meus pagamentos foram:', 'expense'],
    ['Despesas:', 'expense'],
    ['Saídas do dia:', 'expense']
  ])('inherits natural financial section from %s', (input, expected) => {
    expect(cashBatchSectionCue(input)).toBe(expected);
  });

  it.each([
    'amanhã 200 de venda',
    'mês que vem 500 de aluguel',
    'estimo receber 1200 do freela',
    'se eu viajar gasto 900',
    'falta cobrar 110 da Brenda',
    '80 a receber do cliente',
    'todo mês 320 do notebook'
  ])('keeps non-real money outside the factual ledger: %s', input => {
    expect(isCashNonRealBatchSegment(input)).toBe(true);
  });

  it('does not discard a factual payment just because its description mentions a future due date', () => {
    expect(isCashNonRealBatchSegment('paguei hoje 100 da conta que vence amanhã')).toBe(false);
  });

  it('extracts all movements when a verb is stated once and values continue below it', async () => {
    const input = `Bom, eu ganhei hoje
46,00 de um ajuste
28,00 de uma reforma
30,00 de um ajuste
65,00 no trader

E gastei : 12.00 num colírio
E também gaste: 25,00 em lanches`;

    const rows = await fallbackBatch(input);
    expect(rows.map(item => item.amount)).toEqual([46, 28, 30, 65, 12, 25]);
    expect(rows.map(item => item.type)).toEqual([
      'income', 'income', 'income', 'income', 'expense', 'expense'
    ]);
    expect(rows[4]!.description.toLowerCase()).not.toContain('gastei');
    expect(rows[5]!.description.toLowerCase()).not.toContain('gaste');
  });

  it('supports bullets, formal headers and multiple movements on the same line', async () => {
    const input = `Entradas:
- 100 freela e 50 venda
• 25 pix
Gastos:
- 20 mercado e 10 uber`;

    const rows = await fallbackBatch(input);
    expect(rows.map(item => item.amount)).toEqual([100, 50, 25, 20, 10]);
    expect(rows.map(item => item.type)).toEqual(['income', 'income', 'income', 'expense', 'expense']);
  });

  it('changes inherited type when a new movement appears and keeps date context', async () => {
    const input = `Ontem eu recebi
100 de freela
50 de venda
Hoje gastei
20 no almoço`;

    const rows = await fallbackBatch(input);
    expect(rows).toHaveLength(3);
    expect(rows.map(item => item.type)).toEqual(['income', 'income', 'expense']);
    expect(rows[0]!.transactionDate).toBe(rows[1]!.transactionDate);
    expect(rows[2]!.transactionDate).not.toBe(rows[0]!.transactionDate);
  });

  it('filters future, conditional and receivable lines even under an inherited section', async () => {
    const input = `Entradas:
100 freela recebido
amanhã 200 de outra venda
80 a receber da Brenda
Gastos:
50 mercado
se eu viajar 300 hotel
mês que vem 400 combustível`;

    const rows = await fallbackBatch(input);
    expect(rows.map(item => item.amount)).toEqual([100, 50]);
    expect(rows.map(item => item.type)).toEqual(['income', 'expense']);
  });

  it('preserves legitimate repeated values instead of deduplicating by amount', async () => {
    const input = `Ganhos:
50 ajuste A
50 ajuste B
Gastos:
50 almoço`;

    const rows = await fallbackBatch(input);
    expect(rows).toHaveLength(3);
    expect(rows.map(item => item.amount)).toEqual([50, 50, 50]);
    expect(rows.map(item => item.type)).toEqual(['income', 'income', 'expense']);
  });

  it('can parse a batch larger than the old 12-item ceiling', async () => {
    const lines = Array.from({ length: 15 }, (_, index) => `${index + 1},00 serviço ${index + 1}`);
    const rows = await fallbackBatch(`Entradas:\n${lines.join('\n')}`);
    expect(rows).toHaveLength(15);
    expect(rows[0]!.amount).toBe(1);
    expect(rows[14]!.amount).toBe(15);
  });

  it('keeps the confirmation layer aligned with the expanded batch limit and chunks long WhatsApp previews', () => {
    const source = readFileSync(join(process.cwd(), 'src/verticals/cash/confirmation.ts'), 'utf8');
    expect(source).toContain('const MAX_PENDING_TRANSACTIONS = 25');
    expect(source).toContain('prepared.transactions.slice(0, MAX_PENDING_TRANSACTIONS)');
    expect(source).toContain('const MAX_TEXT_CHUNK = 3200');
    expect(source).toContain('chunkedText');
  });

  it('prefers a complete deterministic batch over a partial AI extraction', () => {
    const date = '2026-08-18';
    const make = (type: 'income' | 'expense', amount: number, description: string) => ({
      type,
      amount,
      category: type === 'income' ? 'Receita' : 'Outros',
      merchant: '',
      description,
      transactionDate: date
    });

    const deterministic = [
      make('income', 46, 'ajuste'),
      make('income', 28, 'reforma'),
      make('income', 30, 'ajuste'),
      make('income', 65, 'trader'),
      make('expense', 12, 'colírio'),
      make('expense', 25, 'lanches')
    ];
    const aiPartial = deterministic.slice(4);

    expect(selectCashBatchTransactions(aiPartial, deterministic)).toEqual(deterministic);
  });

  it('allows AI to win when it demonstrably contains all deterministic movements plus more', () => {
    const date = '2026-08-18';
    const make = (amount: number) => ({
      type: 'income' as const,
      amount,
      category: 'Receita',
      merchant: '',
      description: `item ${amount}`,
      transactionDate: date
    });
    const deterministic = [make(10), make(20)];
    const ai = [make(10), make(20), make(30)];
    expect(selectCashBatchTransactions(ai, deterministic)).toEqual(ai);
  });
});