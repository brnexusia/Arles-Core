import { describe, expect, it } from 'vitest';
import { calculateCashContextualValue } from '../src/verticals/cash/contextual-calculation.js';

describe('Arles Cash contextual calculation v2', () => {
  it('calculates the exact user-reported scenario deterministically', () => {
    const result = calculateCashContextualValue({
      base_mode: 'zero',
      explicit_base: null,
      operations: [
        { type: 'income', amount: 600 },
        { type: 'expense', amount: 120 },
        { type: 'expense', amount: 330 },
        { type: 'expense', amount: 600 }
      ]
    });

    expect(result).toEqual({
      base: 0,
      income: 600,
      expense: 1050,
      result: -450
    });
  });

  it('uses current balance only when explicitly requested by the semantic layer', () => {
    expect(calculateCashContextualValue({
      base_mode: 'current_balance',
      explicit_base: null,
      operations: [{ type: 'expense', amount: 50 }]
    }, 300).result).toBe(250);
  });

  it('supports an explicit user-provided base without consulting global balance', () => {
    expect(calculateCashContextualValue({
      base_mode: 'explicit',
      explicit_base: 970,
      operations: [
        { type: 'expense', amount: 77 },
        { type: 'expense', amount: 140 },
        { type: 'expense', amount: 24 }
      ]
    }).result).toBe(729);
  });

  it('rounds financial math to cents', () => {
    expect(calculateCashContextualValue({
      base_mode: 'zero',
      explicit_base: null,
      operations: [
        { type: 'income', amount: 0.1 },
        { type: 'income', amount: 0.2 }
      ]
    }).result).toBe(0.3);
  });
});
