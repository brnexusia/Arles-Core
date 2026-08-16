import { redis } from '../../infrastructure/redis.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashService } from './service.js';
import type { CashTransactionInput } from './types.js';
import { formatBrazilDate } from './time.js';

const TTL_SECONDS = 15 * 60;

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
    item.description ? `📝 ${item.description}` : '',
    `📅 ${formatBrazilDate(item.transactionDate)}`
  ].filter(Boolean).join('\n');
}

function summary(transactions: CashTransactionInput[]): string {
  if (transactions.length === 1) return line(transactions[0]!);
  return transactions.map((item, index) => line(item, index + 1)).join('\n\n');
}

export function isCashRegistrationConfirmation(input: string): boolean {
  const value = normalize(input).replace(/[!.]+$/g, '').trim();
  return /^(sim|confirmo|confirmar|confirma|pode registrar|pode salvar|pode anotar|registra|registre|salva|salve|anota|anote|isso mesmo|esta certo|ta certo|tá certo|correto|pode)$/.test(value);
}

export function isCashRegistrationCancellation(input: string): boolean {
  const value = normalize(input).replace(/[!.]+$/g, '').trim();
  return /^(nao|não|cancelar|cancela|cancele|deixa pra la|deixa pra lá|esquece|descarta|nao registra|não registra|nao salve|não salve)$/.test(value);
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

async function clearPending(companyId: string, phone: string): Promise<void> {
  await redis.del(key(companyId, phone));
}

// Nenhum lançamento novo é persistido aqui. Este passo apenas guarda o resumo
// temporariamente no Redis para o usuário revisar antes de qualquer INSERT.
export async function stageCashRegistration(
  context: VerticalContext,
  transactions: CashTransactionInput[],
  sourceMessage = context.combinedText
): Promise<VerticalResult> {
  const pending: PendingCashRegistration = {
    sourceMessageId: context.message.messageId || `cash:${Date.now()}`,
    sourceMessage: sourceMessage.slice(0, 1000),
    transactions: transactions.slice(0, 12)
  };
  await redis.set(key(context.company.id, context.message.phone), JSON.stringify(pending), 'EX', TTL_SECONDS);

  return text([
    transactions.length === 1
      ? '🧾 Antes de registrar, confirma se entendi certo:'
      : `🧾 Antes de registrar, confirma estes ${transactions.length} lançamentos:`,
    '',
    summary(transactions),
    '',
    'Está certo?',
    'Responda *sim* para registrar ou *não* para cancelar.'
  ].join('\n'));
}

export async function handleCashPendingConfirmation(context: VerticalContext): Promise<VerticalResult | undefined> {
  const pending = await getPending(context.company.id, context.message.phone);
  if (!pending) return undefined;

  if (isCashRegistrationCancellation(context.combinedText)) {
    await clearPending(context.company.id, context.message.phone);
    return text('Tudo bem 👍 Não registrei nada. Pode me mandar novamente do jeito correto.');
  }

  if (!isCashRegistrationConfirmation(context.combinedText)) {
    return text([
      'Tenho um lançamento aguardando sua confirmação.',
      '',
      summary(pending.transactions),
      '',
      'Responda *sim* para registrar ou *não* para cancelar e enviar a informação corrigida.'
    ].join('\n'));
  }

  // Somente este ramo, após confirmação explícita, grava no PostgreSQL.
  const saved: CashTransactionInput[] = [];
  for (let index = 0; index < pending.transactions.length; index += 1) {
    const transaction = pending.transactions[index]!;
    await cashService.createTransaction({
      companyId: context.company.id,
      phone: context.message.phone,
      sourceMessageId: pending.transactions.length === 1
        ? pending.sourceMessageId
        : `${pending.sourceMessageId}:item:${index + 1}`,
      sourceMessage: pending.sourceMessage,
      transaction
    });
    saved.push(transaction);
  }
  await clearPending(context.company.id, context.message.phone);

  return text([
    saved.length === 1 ? '✅ Confirmado e registrado!' : `✅ Confirmado! ${saved.length} lançamentos registrados.`,
    '',
    summary(saved)
  ].join('\n'));
}
