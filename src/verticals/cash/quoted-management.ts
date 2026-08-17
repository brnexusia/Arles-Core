import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashService } from './service.js';
import {
  clearCashEditState,
  setCashEditState
} from './edit-state.js';
import {
  hasCashEditPatch,
  normalizeCashText,
  parseCashEditPatch,
  type CashEditPatch
} from './management.js';
import { formatBrazilDate } from './time.js';
import {
  findCashRecordsByQuotedMessage,
  type CashQuotedRecord
} from './quoted-record.js';

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function recordLabel(row: CashQuotedRecord, index?: number): string {
  const prefix = index == null ? '' : `${index}. `;
  const description = String(row.description ?? row.merchant ?? row.category ?? 'Lançamento').trim();
  return `${prefix}${description || 'Lançamento'} — ${brl(Number(row.amount))}`;
}

export function cashQuotedSelectionIndex(input: string, count: number): number | null {
  if (count <= 1) return count === 1 ? 0 : null;
  const value = normalizeCashText(input);
  const match = value.match(/\b(?:item|registro|registo|lancamento|lancamento|numero|n|#)\s*(\d{1,2})\b/);
  if (!match?.[1]) return null;
  const index = Number(match[1]) - 1;
  return index >= 0 && index < count ? index : null;
}

export function cashQuotedDeleteIntent(input: string): boolean {
  const value = normalizeCashText(input);
  if (/\b(como|posso|consigo|tem como|da pra|da para)\b/.test(value)) return false;
  return /\b(apag|exclu|remov|retir|delet|cancel)\w*/.test(value);
}

export function cashQuotedEditPatch(input: string): CashEditPatch {
  const value = normalizeCashText(input);
  const patch = parseCashEditPatch(input);

  // Em uma resposta citada, frases curtas como “essa foi entrada” ou “isso era
  // despesa” são inequívocas porque a própria citação define o alvo.
  if (/\b(?:foi|era|e|é|tipo)\s+(?:uma\s+)?(?:entrada|receita)\b/.test(value)) {
    patch.type = 'income';
    patch.category = 'Receita';
  } else if (/\b(?:foi|era|e|é|tipo)\s+(?:uma\s+)?(?:despesa|saida|gasto)\b/.test(value)) {
    patch.type = 'expense';
    if (patch.category === 'Receita') patch.category = 'Outros';
  }

  return patch;
}

export function cashQuotedEditIntent(input: string): boolean {
  const value = normalizeCashText(input);
  if (/\b(como|posso|consigo|tem como|da pra|da para)\b/.test(value)) return false;
  if (/\b(edit|alter|mud|corrig|ajust|troc)\w*/.test(value)) return true;
  return hasCashEditPatch(cashQuotedEditPatch(input));
}

function chooseMessage(rows: CashQuotedRecord[], action: 'editar' | 'apagar'): VerticalResult {
  return text([
    `Essa mensagem gerou ${rows.length} lançamentos. Qual deles você quer ${action}?`,
    '',
    ...rows.map((row, index) => recordLabel(row, index + 1)),
    '',
    `Responda citando a mesma mensagem com “${action === 'editar' ? 'editar' : 'apaga'} item 2”, por exemplo.`
  ].join('\n'));
}

async function applyQuotedEdit(companyId: string, row: CashQuotedRecord, patch: CashEditPatch): Promise<any> {
  const type = patch.type ?? row.type;
  const category = type === 'income'
    ? 'Receita'
    : patch.category ?? (row.category === 'Receita' ? 'Outros' : row.category);

  return await cashService.updateTransaction(companyId, row.id, {
    type,
    amount: patch.amount ?? Number(row.amount),
    category,
    merchant: row.merchant ?? null,
    description: patch.description ?? row.description ?? null,
    transaction_date: patch.transaction_date ?? String(row.transaction_date)
  });
}

function updatedMessage(row: any): string {
  const description = String(row.description ?? row.merchant ?? 'Lançamento').trim();
  return [
    '✅ Registro atualizado!',
    `${description || 'Lançamento'} — ${brl(Number(row.amount))}`,
    `📅 ${formatBrazilDate(String(row.transaction_date))}`
  ].join('\n');
}

export async function handleCashQuotedManagement(context: VerticalContext): Promise<VerticalResult | null> {
  const quotedMessageId = String(context.message.quotedMessageId ?? '').trim();
  const quotedText = String(context.message.quotedText ?? '').trim();
  if (!quotedMessageId && !quotedText) return null;

  const wantsDelete = cashQuotedDeleteIntent(context.combinedText);
  const patch = cashQuotedEditPatch(context.combinedText);
  const wantsEdit = cashQuotedEditIntent(context.combinedText);
  if (!wantsDelete && !wantsEdit) return null;

  const rows = await findCashRecordsByQuotedMessage({
    companyId: context.company.id,
    phone: context.message.phone,
    quotedMessageId,
    quotedText
  });
  if (!rows.length) return null;

  const index = cashQuotedSelectionIndex(context.combinedText, rows.length);
  if (index == null) return chooseMessage(rows, wantsDelete ? 'apagar' : 'editar');
  const row = rows[index]!;

  if (wantsDelete) {
    await cashService.deleteTransaction(context.company.id, row.id);
    await clearCashEditState(context.company.id, context.message.phone);
    return text(`🗑️ Registro apagado: ${recordLabel(row)}`);
  }

  if (hasCashEditPatch(patch)) {
    const updated = await applyQuotedEdit(context.company.id, row, patch);
    await clearCashEditState(context.company.id, context.message.phone);
    return text(updatedMessage(updated));
  }

  await setCashEditState(context.company.id, context.message.phone, row.id);
  return text([
    `✏️ Certo. Vou editar este registro: ${recordLabel(row)}`,
    '',
    'Me diga o que quer mudar, por exemplo:',
    '• “o valor foi 80”',
    '• “essa foi entrada”',
    '• “foi ontem”',
    '• “descrição: mercado”'
  ].join('\n'));
}
