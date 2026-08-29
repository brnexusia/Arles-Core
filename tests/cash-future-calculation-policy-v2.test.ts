import { describe, expect, it } from 'vitest';
import { calculateCashContextualValue } from '../src/verticals/cash/contextual-calculation.js';
import fs from 'node:fs';

describe('Arles Cash future calculation policy v2', () => {
  it('keeps the reported future cash-flow arithmetic independent from current balance', () => {
    expect(calculateCashContextualValue({
      base_mode: 'zero', explicit_base: null,
      operations: [
        { type: 'income', amount: 600 },
        { type: 'expense', amount: 120 },
        { type: 'expense', amount: 330 },
        { type: 'expense', amount: 600 }
      ]
    }, 9999).result).toBe(-450);
  });

  it('requires explicit scheduling language before forecast_schedule', () => {
    const source = fs.readFileSync('src/verticals/cash/ai-first-handler.ts', 'utf8');
    expect(source).toContain('Só use forecast_schedule quando houver pedido explícito de salvar, anotar, registrar, agendar ou programar a previsão');
  });

  it('supports explicit starting balance separately', () => {
    expect(calculateCashContextualValue({
      base_mode: 'explicit', explicit_base: 2000,
      operations: [{ type: 'income', amount: 600 }, { type: 'expense', amount: 1050 }]
    }).result).toBe(1550);
  });
});
