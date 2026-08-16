import type { VerticalContext, VerticalResult } from '../vertical.js';
import { clearCashEditState, getCashEditState } from './edit-state.js';
import { deletionTarget, normalizeCashText } from './management.js';
import { cashService } from './service.js';

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function isEditCancellation(input: string): boolean {
  const value = normalizeCashText(input).replace(/[!.]+$/g, '').trim();
  return /^(cancelar edicao|cancela edicao|cancelar a edicao|cancela a edicao|deixa pra la|deixa pra la a edicao)$/.test(value);
}

export async function handleCashPendingEditInteraction(
  context: VerticalContext
): Promise<VerticalResult | undefined> {
  const transactionId = await getCashEditState(context.company.id, context.message.phone);
  if (!transactionId) return undefined;

  // “Cancelar edição” cancela somente o modo de edição. Já “cancela ele” ou
  // “apaga ele” se referem ao próprio lançamento e, portanto, excluem o registro.
  if (isEditCancellation(context.combinedText)) {
    await clearCashEditState(context.company.id, context.message.phone);
    return text('Tudo bem 😊 Edição cancelada. O lançamento continua como estava.');
  }

  if (!deletionTarget(context.combinedText)) return undefined;

  const rows = await cashService.listRecent(context.company.id, context.message.phone, 20);
  const editing = rows.find((row: any) => String(row.id) === transactionId);
  await clearCashEditState(context.company.id, context.message.phone);

  if (!editing) {
    return text('Esse lançamento não existe mais. O modo de edição foi encerrado.');
  }

  await cashService.deleteTransaction(context.company.id, transactionId);
  return text('🗑️ Certo! Lançamento apagado.');
}
