import { beforeAll, describe, expect, it } from 'vitest';

let isCashPocketClosingMessage: (input: string) => boolean;
let parseCashPocketClosing: (input: string) => {
  referenceDate: string | null;
  totalSold: number | null;
  cashCheckpoints: number[];
  cashFinal: number | null;
  receivableTotal: number | null;
  receivableItems: Array<{ amount: number; label: string }>;
  withdrawals: Array<{ amount: number; label: string }>;
  withdrawalsTotal: number;
} | null;
let parseCashPocketReceivableIntent: (input: string) =>
  | { kind: 'create'; amount: number; debtor: string | null }
  | { kind: 'list' }
  | { kind: 'cancel'; amount: number | null }
  | null;

const SCREENSHOT = `Total dos valores vendidos até o dia 31/07/2026

1640,00

Em caixa tem 1530,00
-250,00 Stefane retirou
-250,00 Luiza retirou
-250,00 Stefany retirou
-250,00 Maria retirou

Em caixa tem 530,00

Falta cobrar: 110,00

30,00 Stefane ( devendo de Rosana)

80,00 Brenda

(Registre essas informações no "cofrinho de vendas").`;

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
  process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
  process.env.EVOLUTION_BASE_URL ||= 'http://127.0.0.1:8080';
  process.env.EVOLUTION_API_KEY ||= 'test';
  ({ isCashPocketClosingMessage, parseCashPocketClosing } = await import('../src/verticals/cash/pocket-closing.js'));
  ({ parseCashPocketReceivableIntent } = await import('../src/verticals/cash/pocket-receivables.js'));
});

describe('Cash pocket closing snapshot', () => {
  it('recognizes the exact screenshot as a pocket closing', () => {
    expect(isCashPocketClosingMessage(SCREENSHOT)).toBe(true);
  });

  it('extracts the closing without treating 31/07 as money', () => {
    const closing = parseCashPocketClosing(SCREENSHOT);
    expect(closing).not.toBeNull();
    expect(closing?.referenceDate).toBe('2026-07-31');
    expect(closing?.totalSold).toBe(1640);
    expect(closing?.cashCheckpoints).toEqual([1530, 530]);
    expect(closing?.cashFinal).toBe(530);
    expect(closing?.receivableTotal).toBe(110);
    expect(closing?.withdrawals).toHaveLength(4);
    expect(closing?.withdrawalsTotal).toBe(1000);
    expect(closing?.receivableItems.map(item => item.amount)).toEqual([30, 80]);
  });

  it('reconciles the screenshot arithmetic', () => {
    const closing = parseCashPocketClosing(SCREENSHOT)!;
    expect(closing.totalSold! - closing.receivableTotal! - closing.withdrawalsTotal).toBe(closing.cashFinal);
  });

  it('generic receivable parser ignores dates and prefers the amount after falta cobrar', () => {
    expect(parseCashPocketReceivableIntent('Até 31/07/2026, falta cobrar 110,00 no cofrinho Vendas')).toEqual({
      kind: 'create',
      amount: 110,
      debtor: null
    });
  });
});
