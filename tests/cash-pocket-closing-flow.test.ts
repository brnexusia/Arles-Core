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

  it('checks pending closing interaction before generic pending handlers', () => {
    const moduleSource = readFileSync(join(process.cwd(), 'src/verticals/cash/module.ts'), 'utf8');
    const closing = moduleSource.indexOf('await handleCashPendingPocketClosing(context)');
    const transfer = moduleSource.indexOf('await handleCashPendingPocketTransfer(context)');
    const confirmation = moduleSource.indexOf('await handleCashPendingConfirmation(context)');

    expect(closing).toBeGreaterThan(-1);
    expect(closing).toBeLessThan(transfer);
    expect(closing).toBeLessThan(confirmation);
  });

  it('routes an initial closing through the context-preserving flow before receivables', () => {
    const access = readFileSync(join(process.cwd(), 'src/verticals/cash/access-handler.ts'), 'utf8');
    const closing = access.indexOf('await handleCashPocketClosingFlow(context)');
    const receivable = access.indexOf('await handleCashPocketReceivable(context)');

    expect(closing).toBeGreaterThan(-1);
    expect(closing).toBeLessThan(receivable);
  });

  it('requires AI semantic clarification before falling back to generic help', () => {
    const ai = readFileSync(join(process.cwd(), 'src/verticals/cash/ai-first-handler.ts'), 'utf8');
    expect(ai).toContain("clarification: z.string().nullable()");
    expect(ai).toContain("if (understood.intent === 'unknown')");
    expect(ai).toContain('if (clarification) return text(clarification)');
    expect(ai.indexOf('const understood = await semanticRoute(context)')).toBeLessThan(
      ai.indexOf("if (understood.intent === 'unknown')")
    );
  });
});