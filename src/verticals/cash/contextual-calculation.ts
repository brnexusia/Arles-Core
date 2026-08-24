import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashLedgerService } from './ledger.js';
import { cashService } from './service.js';

export type CashCalculationBaseKind =
  | 'literal'
  | 'transaction'
  | 'global_balance'
  | 'available_balance';

export interface CashCalculationBase {
  kind: CashCalculationBaseKind;
  transaction_id: string | null;
  amount: number | null;
}

export interface CashCalculationOperation {
  operator: 'add' | 'subtract';
  source: 'literal' | 'transaction';
  transaction_id: string | null;
  amount: number | null;
}

export interface CashContextualCalculationSpec {
  base: CashCalculationBase;
  operations: CashCalculationOperation[];
}

export interface CashCalculationTransaction {
  id: string;
  amount: number;
}

export interface CashCalculationState {
  globalBalance: number;
  availableBalance: number;
  transactions: CashCalculationTransaction[];
}

export interface CashCalculationEvaluation {
  base: number;
  steps: Array<{ operator: 'add' | 'subtract'; amount: number }>;
  result: number;
}

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function money(value: unknown): number | null {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 999_999_999) return null;
  return Math.round(amount * 100) / 100;
}

function transactionAmount(
  transactions: CashCalculationTransaction[],
  id: string | null
): number | null {
  if (!id) return null;
  const row = transactions.find(item => item.id === id);
  return row ? money(row.amount) : null;
}

/**
 * Executa somente a matemática. Referências a lançamentos são resolvidas pelos IDs
 * validados do backend; qualquer amount sugerido pela IA é ignorado quando a fonte é
 * um lançamento. Assim o modelo escolhe o referente, mas nunca escolhe o resultado.
 */
export function evaluateCashContextualCalculation(
  spec: CashContextualCalculationSpec,
  state: CashCalculationState
): CashCalculationEvaluation | null {
  let base: number | null;

  if (spec.base.kind === 'transaction') {
    base = transactionAmount(state.transactions, spec.base.transaction_id);
  } else if (spec.base.kind === 'global_balance') {
    base = money(state.globalBalance);
  } else if (spec.base.kind === 'available_balance') {
    base = money(state.availableBalance);
  } else {
    base = money(spec.base.amount);
  }

  if (base == null) return null;

  const steps: CashCalculationEvaluation['steps'] = [];
  let result = base;
  for (const operation of spec.operations) {
    const amount = operation.source === 'transaction'
      ? transactionAmount(state.transactions, operation.transaction_id)
      : money(operation.amount);
    if (amount == null) return null;

    result = operation.operator === 'add' ? result + amount : result - amount;
    result = Math.round(result * 100) / 100;
    steps.push({ operator: operation.operator, amount });
  }

  return { base, steps, result };
}

export async function executeCashContextualCalculation(
  context: VerticalContext,
  spec: CashContextualCalculationSpec | null | undefined
): Promise<VerticalResult> {
  if (!spec || !spec.operations.length) {
    return text('Entendi que você quer fazer uma conta, mas faltou identificar com segurança quais valores entram nela. Pode dizer qual valor ou lançamento deve ser a base?');
  }

  const [rows, snapshot, availability] = await Promise.all([
    cashService.listTransactions(context.company.id, { limit: 30 }),
    cashLedgerService.snapshot(context.company.id),
    cashLedgerService.availability(context.company.id)
  ]);

  const state: CashCalculationState = {
    globalBalance: snapshot.balance,
    availableBalance: availability.available,
    transactions: rows.map((row: any) => ({
      id: String(row.id),
      amount: Number(row.amount)
    }))
  };
  const evaluation = evaluateCashContextualCalculation(spec, state);

  if (!evaluation) {
    return text('Não consegui validar no seu histórico uma das referências usadas nessa conta. Me diga qual lançamento ou valor você quer usar e eu calculo sem alterar seu saldo.');
  }

  const operations = evaluation.steps.map(step =>
    `${step.operator === 'add' ? '➕' : '➖'} ${brl(step.amount)}`
  );

  return text([
    '🧮 *Cálculo contextual*',
    `Base: ${brl(evaluation.base)}`,
    ...operations,
    `= *${brl(evaluation.result)}*`
  ].join('\n'));
}
