import { db } from '../../infrastructure/db.js';
import type { CashTransactionInput } from './types.js';
import { cashPocketService } from './cofrinhos.js';

export async function prepareCashPocketTransactions(
  companyId: string,
  source: string,
  transactions: CashTransactionInput[]
): Promise<{ transactions: CashTransactionInput[]; error: string | null }> {
  const reference = await cashPocketService.findMentioned(companyId, source);
  if (!reference.explicit) return { transactions, error: null };

  if (!reference.pocket) {
    const name = reference.requestedName || 'informado';
    return {
      transactions,
      error: `Não encontrei o cofrinho *${name}*. Crie primeiro com “criar cofrinho ${name}” ou mande “meus cofrinhos”.`
    };
  }

  return {
    error: null,
    transactions: transactions.map(transaction => ({
      ...transaction,
      pocketId: reference.pocket!.id,
      pocketName: reference.pocket!.name
    }))
  };
}

export async function assignCashTransactionPocket(
  companyId: string,
  transactionId: string,
  pocketId?: string | null
): Promise<void> {
  if (!pocketId) return;
  await db.query(
    `update cash_transactions
     set pocket_id=$3,updated_at=now()
     where company_id=$1 and id=$2`,
    [companyId, transactionId, pocketId]
  );
}
