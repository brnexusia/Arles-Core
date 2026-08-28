export type CashContextualCalculationBaseMode = 'zero' | 'current_balance' | 'explicit';

export interface CashContextualCalculationOperation {
  type: 'income' | 'expense';
  amount: number;
}

export interface CashContextualCalculationSpec {
  base_mode: CashContextualCalculationBaseMode;
  explicit_base: number | null;
  operations: CashContextualCalculationOperation[];
}

export interface CashContextualCalculationResult {
  base: number;
  result: number;
  income: number;
  expense: number;
}

function roundMoney(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Invalid financial value');
  return Math.round(value * 100) / 100;
}

export function calculateCashContextualValue(
  spec: CashContextualCalculationSpec,
  currentBalance = 0
): CashContextualCalculationResult {
  if (!spec.operations.length) throw new Error('Calculation has no operations');
  if (spec.operations.length > 30) throw new Error('Calculation exceeds operation limit');

  const base = spec.base_mode === 'explicit'
    ? spec.explicit_base
    : spec.base_mode === 'current_balance'
      ? currentBalance
      : 0;

  if (base == null || !Number.isFinite(base)) throw new Error('Invalid calculation base');

  let income = 0;
  let expense = 0;
  for (const operation of spec.operations) {
    if (!Number.isFinite(operation.amount) || operation.amount <= 0) {
      throw new Error('Invalid calculation operation');
    }
    if (operation.type === 'income') income += operation.amount;
    else expense += operation.amount;
  }

  income = roundMoney(income);
  expense = roundMoney(expense);
  return {
    base: roundMoney(base),
    income,
    expense,
    result: roundMoney(base + income - expense)
  };
}
