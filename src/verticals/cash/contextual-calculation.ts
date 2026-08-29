import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashLedgerService } from './ledger.js';

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

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
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
    if (!Number.isFinite(operation.amount) || operation.amount <= 0) throw new Error('Invalid calculation operation');
    if (operation.type === 'income') income += operation.amount;
    else expense += operation.amount;
  }

  income = roundMoney(income);
  expense = roundMoney(expense);
  return { base: roundMoney(base), income, expense, result: roundMoney(base + income - expense) };
}

export async function executeCashContextualCalculation(
  context: VerticalContext,
  spec: CashContextualCalculationSpec | null | undefined
): Promise<VerticalResult> {
  if (!spec?.operations?.length) {
    return text('Entendi que você quer fazer uma conta, mas faltou identificar os valores com segurança.');
  }

  try {
    const currentBalance = spec.base_mode === 'current_balance'
      ? (await cashLedgerService.snapshot(context.company.id)).balance
      : 0;
    const result = calculateCashContextualValue(spec, currentBalance);
    const operations = spec.operations.map(operation =>
      `${operation.type === 'income' ? '➕' : '➖'} ${brl(operation.amount)}`
    );
    const baseLine = spec.base_mode === 'zero' ? [] : [`Base: ${brl(result.base)}`];
    return text([
      '🧮 *Cálculo*',
      ...baseLine,
      ...operations,
      `Resultado: *${brl(result.result)}*`,
      '',
      'Não registrei nenhum lançamento — foi só um cálculo.'
    ].join('\n'));
  } catch {
    return text('Não consegui validar os valores dessa conta. Pode repetir os valores que entram e saem?');
  }
}
