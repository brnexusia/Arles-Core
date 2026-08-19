import { redis } from '../../infrastructure/redis.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashService } from './service.js';
import type { CashTransactionInput } from './types.js';
import { formatBrazilDate } from './time.js';
import {
  hasCashEditPatch,
  parseCashEditPatch,
  type CashEditPatch
} from './management.js';
import {
  assignCashTransactionPocket,
  prepareCashPocketTransactions
} from './pocket-assignment.js';
import {
  clearCashDeferredQuery,
  consumeCashDeferredQuery,
  rememberCashQueryContext,
  rememberCashRecentRecordReference
} from './conversation-state.js';
import {
  clearCashFinancialIntentContext,
  rememberCashFinancialIntentContext
} from './intent-context.js';
import { interpretCashFinancialIntent } from './financial-intent.js';
import { handleCashLedgerDeterministic } from './ledger.js';
import { cashQuery } from './query.js';

const TTL_SECONDS = 15 * 60;
const MAX_PENDING_TRANSACTIONS = 25;
const MAX_TEXT_CHUNK = 3200;

type PendingCashRegistration = {
  sourceMessageId: string;
  sourceMessage: string;
  transactions: CashTransactionInput[];
};

function key(companyId: string, phone: string): string {
  return `arles:cash:pending-registration:${companyId}:${phone.replace(/\D/g, '')}`;
}

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function line(item: CashTransactionInput, index?: number): string {
  const prefix = index == null ? '' : `${index}. `;
  const icon = item.type === 'income' ? '💰' : item.category === 'Reserva' ? '🏦' : '💸';
  const type = item.type === 'income' ? 'Receita' : item.category === 'Reserva' ? 'Reserva' : 'Despesa';
  return [
    `${prefix}${icon} ${type}: ${brl(item.amount)}`,
    `📂 ${item.category}`,
    item.pocketName ? `🐷 Cofrinho: ${item.pocketName}` : '',
    item.description ? `📝 ${item.description}` : '',
    `📅 ${formatBrazilDate(item.transactionDate)}`
  ].filter(Boolean).join('\n');
}

function summary(transactions: CashTransactionInput[]): string {
  if (transactions.length === 1) return line(transactions[0]!);
  return transactions.map((item, index) => line(item, index + 1)).join('\n\n');
}

function options(): string {
  return 'Responda *sim* para registrar, *não* para cancelar ou *editar* para corrigir.';
}

/**
 * WhatsApp pode rejeitar mensagens gigantes. Mantemos todos os itens pendentes e,
 * quando a confirmação passa do limite confortável, dividimos em várias ações de texto
 * sem cortar lançamentos silenciosamente.
 */
function chunkedText(parts: string[]): VerticalResult {
  const chunks: string[] = [];
  let current = '';

  for (const raw of parts.filter(Boolean)) {
    const part = raw.trim();
    if (!part) continue;
    const candidate = current ? `${current}\n\n${part}` : part;
    if (candidate.length <= MAX_TEXT_CHUNK) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);

    if (part.length <= MAX_TEXT_CHUNK) {
      current = part;
      continue;
    }

    for (let offset = 0; offset < part.length; offset += MAX_TEXT_CHUNK) {
      chunks.push(part.slice(offset, offset + MAX_TEXT_CHUNK));
    }
    current = '';
  }

  if (current) chunks.push(current);
  return { actions: chunks.map(chunk => ({ type: 'text' as const, text: chunk })) };
}

function confirmationResult(transactions: CashTransactionInput[], intro: string): VerticalResult {
  const itemBlocks = transactions.length === 1
    ? [line(transactions[0]!)]
    : transactions.map((item, index) => line(item, index + 1));
  return chunkedText([
    intro,
    ...itemBlocks,
    ['Está certo?', options()].join('\n')
  ]);
}

export function cashRegistrationSavedMessage(count: number): string {
  return count === 1
    ? '✅ Confirmado! Lançamento registrado.'
    : `✅ Confirmado! ${count} lançamentos registrados.`;
}

export function isCashRegistrationConfirmation(input: string): boolean {
  const value = normalize(input).replace(/[!.]+$/g, '').trim();
  return /^(sim|confirmo|confirmar|confirma|pode registrar|pode salvar|pode anotar|registra|registre|salva|salve|anota|anote|isso mesmo|esta certo|ta certo|tá certo|correto|pode)$/.test(value);
}

export function isCashRegistrationCancellation(input: string): boolean {
  const value = normalize(input).replace(/[!.]+$/g, '').trim();
  return /^(nao|não|cancelar|cancela|cancele|deixa pra la|deixa pra lá|esquece|descarta|nao registra|não registra|nao salve|não salve)$/.test(value);
}

export function isCashRegistrationEditRequest(input: string): boolean {
  const value = normalize(input).replace(/[!.]+$/g, '').trim();
  return /\b(edit|corrig|alter|mud|troc|ajust)\w*/.test(value)
    || /^(valor|categoria|descricao|descrição|data|tipo)\b/.test(value);
}

async function getPending(companyId: string, phone: string): Promise<PendingCashRegistration | null> {
  const raw = await redis.get(key(companyId, phone));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as PendingCashRegistration;
    return Array.isArray(value.transactions) && value.transactions.length ? value : null;
  } catch {
    return null;
  }
}

export async function getCashPendingRegistration(
  companyId: string,
  phone: string
): Promise<PendingCashRegistration | null> {
  return await getPending(companyId, phone);
}

async function savePending(companyId: string, phone: string, pending: PendingCashRegistration): Promise<void> {
  await redis.set(key(companyId, phone), JSON.stringify(pending), 'EX', TTL_SECONDS);
}

async function clearPending(companyId: string, phone: string): Promise<void> {
  await redis.del(key(companyId, phone));
}

function requestedIndex(input: string, count: number): number | null {
  if (count === 1) return 0;
  const value = normalize(input);
  const match = value.match(/\b(?:item|lancamento|lançamento|registro|numero|n|#)?\s*(\d{1,2})\b/);
  if (!match?.[1]) return null;
  const index = Number(match[1]) - 1;
  return index >= 0 && index < count ? index : null;
}

function applyPatch(item: CashTransactionInput, patch: CashEditPatch): CashTransactionInput {
  const type = patch.type ?? item.type;
  const category = type === 'income'
    ? 'Receita'
    : patch.category ?? (item.category === 'Receita' ? 'Outros' : item.category);

  return {
    ...item,
    type,
    category,
    amount: patch.amount ?? item.amount,
    description: patch.description ?? item.description,
    transactionDate: patch.transaction_date ?? item.transactionDate
  };
}

function editHelp(pending: PendingCashRegistration, index: number | null): VerticalResult {
  const target = index == null ? 'o item que quer alterar' : `o item ${index + 1}`;
  return text([
    `✏️ Certo. Me diga o que quer mudar em ${target}.`,
    '',
    'Exemplos:',
    pending.transactions.length > 1 ? '• “editar 2 valor 80”' : '• “o valor foi 80”',
    pending.transactions.length > 1 ? '• “item 1 categoria Pessoal”' : '• “categoria Pessoal”',
    '• “descrição: pão, leite e café”',
    '• “foi ontem”',
    '',
    'Nada será registrado até você confirmar.'
  ].join('\n'));
}

// Todo novo lançamento inicia um novo estado conversacional. A invalidação aqui é
// central e cobre parser novo, lote, corpus legado e qualquer rota futura que use stage.
export async function stageCashRegistration(
  context: VerticalContext,
  transactions: CashTransactionInput[],
  sourceMessage = context.combinedText
): Promise<VerticalResult> {
  const prepared = await prepareCashPocketTransactions(context.company.id, sourceMessage, transactions);
  if (prepared.error) return text(prepared.error);

  await clearCashFinancialIntentContext(context.company.id, context.message.phone);

  const pending: PendingCashRegistration = {
    sourceMessageId: context.message.messageId || `cash:${Date.now()}`,
    sourceMessage: sourceMessage.slice(0, 5000),
    transactions: prepared.transactions.slice(0, MAX_PENDING_TRANSACTIONS)
  };
  await savePending(context.company.id, context.message.phone, pending);

  return confirmationResult(
    pending.transactions,
    pending.transactions.length === 1
      ? '🧾 Antes de registrar, confirma se entendi certo:'
      : `🧾 Antes de registrar, confirma estes ${pending.transactions.length} lançamentos:`
  );
}

async function deferredResult(context: VerticalContext, query: string): Promise<VerticalResult | null> {
  const typedIntent = interpretCashFinancialIntent(query);
  if (typedIntent?.needsClarification === 'period') {
    await rememberCashFinancialIntentContext(context.company.id, context.message.phone, typedIntent);
    return text('Entendi a consulta, mas falta o período. Me diga “hoje”, “este mês”, “mês passado” ou “no total”.');
  }

  const ledger = await handleCashLedgerDeterministic({ ...context, combinedText: query });
  if (ledger) {
    if (typedIntent) await rememberCashFinancialIntentContext(context.company.id, context.message.phone, typedIntent);
    return ledger;
  }

  const result = await cashQuery.handle(context.company.id, typedIntent?.canonical ?? query);
  if (result) {
    await rememberCashQueryContext(context.company.id, context.message.phone, typedIntent?.canonical ?? query);
    if (typedIntent) await rememberCashFinancialIntentContext(context.company.id, context.message.phone, typedIntent);
  }
  return result;
}

export async function handleCashPendingConfirmation(context: VerticalContext): Promise<VerticalResult | undefined> {
  const pending = await getPending(context.company.id, context.message.phone);
  if (!pending) return undefined;

  if (isCashRegistrationCancellation(context.combinedText)) {
    await clearPending(context.company.id, context.message.phone);
    await clearCashDeferredQuery(context.company.id, context.message.phone);
    return text('Tudo bem 👍 Não registrei nada. Pode me mandar novamente do jeito correto.');
  }

  if (isCashRegistrationConfirmation(context.combinedText)) {
    const saved: CashTransactionInput[] = [];
    for (let index = 0; index < pending.transactions.length; index += 1) {
      const transaction = pending.transactions[index]!;
      const created = await cashService.createTransaction({
        companyId: context.company.id,
        phone: context.message.phone,
        sourceMessageId: pending.transactions.length === 1
          ? pending.sourceMessageId
          : `${pending.sourceMessageId}:item:${index + 1}`,
        sourceMessage: pending.sourceMessage,
        transaction
      });
      await assignCashTransactionPocket(context.company.id, String(created.id), transaction.pocketId);
      saved.push(transaction);
    }
    await clearPending(context.company.id, context.message.phone);
    await rememberCashRecentRecordReference(context.company.id, context.message.phone);

    const confirmed = cashRegistrationSavedMessage(saved.length);
    const deferred = await consumeCashDeferredQuery(context.company.id, context.message.phone);
    if (deferred) {
      const followup = await deferredResult(context, deferred);
      if (followup) {
        return {
          actions: [
            { type: 'text', text: confirmed },
            ...followup.actions
          ]
        };
      }
    }

    return text(confirmed);
  }

  const patch = parseCashEditPatch(context.combinedText);
  const wantsEdit = isCashRegistrationEditRequest(context.combinedText) || hasCashEditPatch(patch);
  if (wantsEdit) {
    const index = requestedIndex(context.combinedText, pending.transactions.length);
    if (index == null) return editHelp(pending, null);
    if (!hasCashEditPatch(patch)) return editHelp(pending, index);

    pending.transactions[index] = applyPatch(pending.transactions[index]!, patch);
    await savePending(context.company.id, context.message.phone, pending);
    return confirmationResult(pending.transactions, `✏️ Ajustei o item ${index + 1}:`);
  }

  return confirmationResult(pending.transactions, 'Tenho um lançamento aguardando sua confirmação.');
}