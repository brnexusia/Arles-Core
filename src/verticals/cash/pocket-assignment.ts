import { db } from '../../infrastructure/db.js';
import type { CashTransactionInput } from './types.js';
import { cashPocketService, type CashPocket } from './cofrinhos.js';
import { normalizeCashPocketLanguage } from './pocket-language.js';

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export async function prepareCashPocketTransactions(
  companyId: string,
  source: string,
  transactions: CashTransactionInput[]
): Promise<{ transactions: CashTransactionInput[]; error: string | null }> {
  const reference = await cashPocketService.findMentioned(companyId, normalizeCashPocketLanguage(source));
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

function looksLikeReceivedMoney(source: string): boolean {
  const value = String(source ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return /\b(recebi|entrou|caiu|depositaram|me pagou|me pagaram|foi pago|foi recebido)\b/.test(value);
}

async function settleMatchingReceivable(
  companyId: string,
  transactionId: string,
  pocketId: string
): Promise<void> {
  const transactionResult = await db.query<{
    type: string;
    amount: number;
    source_message: string | null;
  }>(
    `select type,amount::float8,source_message
     from cash_transactions
     where company_id=$1 and id=$2
     limit 1`,
    [companyId, transactionId]
  );
  const transaction = transactionResult.rows[0];
  if (!transaction || transaction.type !== 'income' || !looksLikeReceivedMoney(transaction.source_message ?? '')) return;

  // Só baixamos automaticamente quando existe uma pendência do mesmo valor no mesmo
  // cofrinho. Isso evita transformar qualquer receita nova em quitação por engano.
  await db.query(
    `with target as (
       select id
       from cash_pocket_receivables
       where company_id=$1
         and pocket_id=$2
         and status='pending'
         and amount=$3::numeric
       order by due_date asc nulls last,created_at asc
       limit 1
     )
     update cash_pocket_receivables r
     set status='received',received_transaction_id=$4,updated_at=now()
     from target
     where r.id=target.id`,
    [companyId, pocketId, Number(transaction.amount), transactionId]
  );
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
  await settleMatchingReceivable(companyId, transactionId, pocketId);
}
