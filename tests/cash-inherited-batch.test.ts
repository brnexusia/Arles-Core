import { beforeAll, describe, expect, it } from 'vitest';

let cashBatchSectionCue: (input: string) => 'income' | 'expense' | null;
let fallbackBatch: (input: string) => Promise<Array<{ type: 'income' | 'expense'; amount: number; category: string }>>;

const SCREENSHOT = `Bom, eu ganhei hoje
46,00 de um ajuste
28,00 de uma reforma
30,00 de um ajuste
65,00 no trader

E gastei : 12.00 num colírio
E também gaste: 25,00 em lanches`;

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
  process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
  process.env.EVOLUTION_BASE_URL ||= 'http://127.0.0.1:8080';
  process.env.EVOLUTION_API_KEY ||= 'test';
  ({ cashBatchSectionCue, fallbackBatch } = await import('../src/verticals/cash/smart-input.js'));
});

describe('Cash inherited batch sections', () => {
  it('treats a natural heading as an income section', () => {
    expect(cashBatchSectionCue('Bom, eu ganhei hoje')).toBe('income');
    expect(cashBatchSectionCue('E gastei: 12 num colírio')).toBe('expense');
    expect(cashBatchSectionCue('E também gaste: 25 em lanches')).toBe('expense');
  });

  it('extracts all six movements from the exact screenshot pattern', async () => {
    const rows = await fallbackBatch(SCREENSHOT);

    expect(rows).toHaveLength(6);
    expect(rows.map(item => item.amount)).toEqual([46, 28, 30, 65, 12, 25]);
    expect(rows.map(item => item.type)).toEqual([
      'income', 'income', 'income', 'income', 'expense', 'expense'
    ]);
    expect(rows.slice(0, 4).every(item => item.category === 'Receita')).toBe(true);
  });
});
