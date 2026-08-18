import { db } from '../../infrastructure/db.js';
import type { CashTransactionInput } from './types.js';
import { cashPocketService, type CashPocket } from './cofrinhos.js';

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function normalizePocketReference(value: string): string {
  return String(value ?? '')
    .replace(/\bconfrinho\b/gi, 'cofrinho')
    .replace(/\bcofrino\b/gi, 'cofrinho')
    .replace(/\bconfrino\b/gi, 'cofrinho')
    .replace(/\bcaixinha\b/gi, 'cofrinho')
    .replace(/\benvelope\b/gi, 'cofrinho')
    .replace(/\bpotinho\b/gi, 'cofrinho')
    .replace(/\bporquinho\b/gi, 'cofrinho');
}

export async function prepareCashPocketTransactions(
  companyId: string,
  source: string,
  transactions: CashTransactionInput[]
): Promise<{ transactions: CashTransactionInput[]; error: string | null }> {
  const reference = await cashPocketService.findMentioned(companyId, normalizePocketReference(source));
  if (!reference.explicit) return { transactions, error: null };

  let pocket: CashPocket | null = reference.pocket;
  if (!pocket && !reference.requestedName) {
    const pockets = await cashPocketService.list(companyId);
    if (pockets.length === 1) pocket = pockets[0]!;
    else if (pockets.length > 1) {
      return {
        transactions,
        error: ['Qual cofrinho você quer usar?', ...pockets.map(item => `• ${item.name}`), '', 'Diga o nome, por exemplo: “gastei 30 do cofrinho Sonho”.'].join('\n')
      };
    }
  }

  if (!pocket) {
    const name = reference.requestedName;
    return {
      transactions,
      error: name
        ? `Não encontrei o cofrinho *${name}*. Crie primeiro com “criar cofrinho ${name}” ou mande “meus cofrinhos”.`
        : 'Não consegui identificar qual cofrinho você quis usar. Mande “meus cofrinhos” para conferir os nomes.'
    };
  }

  // O cofrinho funciona como dinheiro separado. Uma despesa não pode deixá-lo
  // negativo, senão o saldo livre poderia ficar artificialmente maior que o total.
  const current = await cashPocketService.balance(companyId, pocket.id);
  let projected = Number(current.balance);
  for (const transaction of transactions) {
    projected += transaction.type === 'income' ? transaction.amount : -transaction.amount;
    if (projected < -0.005) {
      return {
        transactions,
        error: [
          `🐷 O cofrinho *${pocket.name}* tem *${brl(current.balance)}* disponível.`,
          `Esses lançamentos deixariam o cofrinho negativo em ${brl(projected)}.`,
          '',
          'Não registrei nada. Ajuste o valor ou coloque dinheiro no cofrinho primeiro.'
        ].join('\n')
      };
    }
  }

  return {
    error: null,
    transactions: transactions.map(transaction => ({
      ...transaction,
      pocketId: pocket!.id,
      pocketName: pocket!.name
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
