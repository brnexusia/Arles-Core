import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

let extractRequestedClosingPocketName: (input: string) => string | null;

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
  process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
  process.env.EVOLUTION_BASE_URL ||= 'http://127.0.0.1:8080';
  process.env.EVOLUTION_API_KEY ||= 'test';
  ({ extractRequestedClosingPocketName } = await import('../src/verticals/cash/pocket-closing-flow.js'));
});

describe('Cash closing pocket continuity', () => {
  it('extracts the cofrinho named in the exact screenshot wording', () => {
    const input = `Total dos valores vendidos até o dia 31/07/2026
1640,00
Em caixa tem 1530,00
-250,00 Stefane retirou
Em caixa tem 530,00
Falta cobrar: 110,00
30,00 Stefane (devendo de Rosana)
80,00 Brenda
(Registre essas informações no "cofrinho de vendas").`;
    expect(extractRequestedClosingPocketName(input)?.toLowerCase()).toBe('vendas');
  });

  it.each([
    ['registre no cofrinho Vendas', 'Vendas'],
    ['salva isso no cofrinho de Trabalho', 'Trabalho'],
    ['coloca no cofrinho da Luiza', 'Luiza'],
    ['anote no cofrinho do Caixa Loja', 'Caixa Loja']
  ])('understands natural pocket destination: %s', (input, expected) => {
    expect(extractRequestedClosingPocketName(input)).toBe(expected);
  });

  it('keeps pending semantics centralized after semantic interpretation', () => {
    const ai = readFileSync(join(process.cwd(), 'src/verticals/cash/ai-first-handler.ts'), 'utf8');
    expect(ai).toContain('executeCashPendingSemanticDecision');
    expect(ai).toContain("understood.intent === 'confirmation'");
    expect(ai).toContain("understood.intent === 'cancellation'");
  });

  it('keeps pocket closing before receivables inside the pocket executor', () => {
    const ai = readFileSync(join(process.cwd(), 'src/verticals/cash/ai-first-handler.ts'), 'utf8');
    const closing = ai.indexOf('handleCashPocketClosingFlow(c)');
    const receivable = ai.indexOf('handleCashPocketReceivable(c)');
    expect(closing).toBeGreaterThan(-1);
    expect(receivable).toBeGreaterThan(-1);
    expect(closing).toBeLessThan(receivable);
  });

  it('requires semantic clarification before generic fallback', () => {
    const ai = readFileSync(join(process.cwd(), 'src/verticals/cash/ai-first-handler.ts'), 'utf8');
    expect(ai).toContain('clarification: z.string().nullable()');
    expect(ai).toContain("if (understood.intent === 'unknown')");
    expect(ai).toContain('understood.clarification?.trim()');
    expect(ai.indexOf('const semantic = await semanticRoute(context)')).toBeLessThan(ai.indexOf("if (understood.intent === 'unknown')"));
  });
});
