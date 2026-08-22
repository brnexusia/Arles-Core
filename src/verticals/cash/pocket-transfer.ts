import { redis } from '../../infrastructure/redis.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashPocketService, type CashPocketBalance } from './cofrinhos.js';
import { cashLedgerService } from './ledger.js';

const TTL_SECONDS = 15 * 60;

type PocketTransferDirection = 'in' | 'out';

type PendingPocketTransfer = {
  pocketId: string;
  pocketName: string;
  direction: PocketTransferDirection;
  amount: number;
};

export type CashPocketTransferIntent = {
  direction: PocketTransferDirection;
  amount: number;
  simulation: boolean;
} | null;

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCashPocketSynonyms(value: string): string {
  return String(value ?? '')
    .replace(/\bconfrinho\b/gi, 'cofrinho')
    .replace(/\bcofrino\b/gi, 'cofrinho')
    .replace(/\bconfrino\b/gi, 'cofrinho')
    .replace(/\bcaixinha\b/gi, 'cofrinho')
    .replace(/\benvelope\b/gi, 'cofrinho')
    .replace(/\bpotinho\b/gi, 'cofrinho')
    .replace(/\bporquinho\b/gi, 'cofrinho');
}

function money(raw: string): number | null {
  const value = String(raw ?? '').trim();
  const normalized = /^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(value)
    ? value.replace(/\./g, '').replace(',', '.')
    : value.replace(',', '.');
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? round(amount) : null;
}

function amountFrom(input: string): number | null {
  const matches = [...String(input ?? '').matchAll(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/gi)];
  for (const match of matches) {
    const amount = money(match[1] ?? '');
    if (amount != null) return amount;
  }
  return null;
}

function hasFutureScheduleLanguage(value: string): boolean {
  return /\b(amanha|depois de amanha|mes que vem|semana que vem|proximo mes|proxima semana|todo dia|toda semana|todo mes|todo ano|mensalmente|semanalmente|diariamente|anualmente|daqui a\s+\d+\s+dias?)\b/.test(value);
}

export function parseCashPocketTransferIntent(input: string): CashPocketTransferIntent {
  const canonical = normalizeCashPocketSynonyms(input);
  const value = normalize(canonical);
  if (!/\bcofrinh(?:o|os)\b/.test(value)) return null;

  const amount = amountFrom(canonical);
  if (!amount) return null;

  const simulation = /\b(se eu|se colocar|se guardar|se separar|se reservar|quanto (?:vou|vai|iria|ficaria)|quanto sobra|quanto fica|como fica|ficaria|vou ter|terei|saldo livre|disponivel|disponível|sem incluir|sem contar|sem mexer)\b/.test(value)
    || /\?$/.test(String(input).trim());

  if (hasFutureScheduleLanguage(value) && !simulation) return null;

  const out = /\b(tirar|tira|retirar|retira|resgatar|resgata|sacar|saca|devolver|devolve|liberar|libera|desreservar|desreserva)\b/.test(value)
    || /\b(?:mover|move|transferir|transfere)\b.*\b(?:do|de)\s+cofrinho\b/.test(value);
  if (out) return { direction: 'out', amount, simulation };

  const into = /\b(guardar|guarda|guarde|colocar|coloca|coloque|botar|bota|bote|separar|separa|separe|reservar|reserva|reserve|poupar|poupa)\b/.test(value)
    || /\b(?:mover|move|transferir|transfere|mandar|manda)\b.*\b(?:para|pro|pra|no|na)\s+(?:o\s+)?cofrinho\b/.test(value);
  if (into) return { direction: 'in', amount, simulation };

  return null;
}

function phoneDigits(value: string): string {
  return String(value ?? '').replace(/\D/g, '');
}

function pendingKey(companyId: string, phone: string): string {
  return `arles:cash:pending-pocket-transfer:${companyId}:${phoneDigits(phone)}`;
}

function pocketContextKey(companyId: string, phone: string): string {
  return `arles:cash:pocket-context:${companyId}:${phoneDigits(phone)}`;
}

async function savePending(context: VerticalContext, pending: PendingPocketTransfer): Promise<void> {
  await redis.set(pendingKey(context.company.id, context.message.phone), JSON.stringify(pending), 'EX', TTL_SECONDS);
}

async function getPending(context: VerticalContext): Promise<PendingPocketTransfer | null> {
  const raw = await redis.get(pendingKey(context.company.id, context.message.phone));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingPocketTransfer;
    if (!parsed?.pocketId || !parsed?.pocketName || !parsed?.amount || !['in', 'out'].includes(parsed.direction)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function clearPending(context: VerticalContext): Promise<void> {
  await redis.del(pendingKey(context.company.id, context.message.phone));
}

async function rememberedPocket(context: VerticalContext): Promise<CashPocketBalance | null> {
  const raw = await redis.get(pocketContextKey(context.company.id, context.message.phone));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { ids?: string[] };
    if (!Array.isArray(parsed.ids) || parsed.ids.length !== 1) return null;
    const all = await cashPocketService.list(context.company.id);
    return all.find(item => String(item.id) === String(parsed.ids![0])) ?? null;
  } catch {
    return null;
  }
}

async function resolvePocket(context: VerticalContext): Promise<{ pocket: CashPocketBalance | null; error: string | null }> {
  const canonical = normalizeCashPocketSynonyms(context.combinedText);
  const mentioned = await cashPocketService.findMentioned(context.company.id, canonical);
  const all = await cashPocketService.list(context.company.id);

  if (mentioned.pocket) {
    return { pocket: all.find(item => item.id === mentioned.pocket!.id) ?? null, error: null };
  }

  if (mentioned.requestedName) {
    return {
      pocket: null,
      error: `Não encontrei o cofrinho *${mentioned.requestedName}*. Mande “meus cofrinhos” para conferir os nomes.`
    };
  }

  const remembered = await rememberedPocket(context);
  if (remembered) return { pocket: remembered, error: null };
  if (all.length === 1) return { pocket: all[0]!, error: null };
  if (!all.length) return { pocket: null, error: 'Você ainda não tem cofrinhos. Crie um primeiro, por exemplo: “criar cofrinho Sonho”.' };

  return {
    pocket: null,
    error: ['Qual cofrinho você quer usar?', ...all.map(item => `• ${item.name}`), '', 'Exemplo: “guardar 450 no cofrinho Sonho”.'].join('\n')
  };
}

async function balances(companyId: string): Promise<{ total: number; pockets: CashPocketBalance[]; pocketTotal: number; available: number }> {
  const [snapshot, pockets] = await Promise.all([
    cashLedgerService.snapshot(companyId),
    cashPocketService.list(companyId)
  ]);
  const pocketTotal = round(pockets.reduce((sum, pocket) => sum + Number(pocket.balance), 0));
  return {
    total: round(snapshot.balance),
    pockets,
    pocketTotal,
    available: round(snapshot.balance - pocketTotal)
  };
}

function isAvailabilityQuery(input: string): boolean {
  const value = normalize(normalizeCashPocketSynonyms(input));
  const asksAvailable = /\b(disponivel|saldo livre|dinheiro livre|quanto posso gastar|quanto tenho fora|quanto sobra fora|sem incluir|sem contar|sem mexer)\b/.test(value);
  return asksAvailable && /\bcofrinh(?:o|os)\b/.test(value);
}

export async function handleCashPocketAvailabilityQuery(context: VerticalContext): Promise<VerticalResult | null> {
  if (!isAvailabilityQuery(context.combinedText) || parseCashPocketTransferIntent(context.combinedText)) return null;
  const state = await balances(context.company.id);
  return text([
    '💰 *Seu dinheiro agora*',
    `Disponível fora dos cofrinhos: *${brl(state.available)}*`,
    `Guardado nos cofrinhos: ${brl(state.pocketTotal)}`,
    `Saldo total: ${brl(state.total)}`,
    '',
    'O valor guardado continua sendo seu; só fica separado do que está livre para gastar.'
  ].join('\n'));
}

async function preview(context: VerticalContext, pending: PendingPocketTransfer, confirmationPrompt = true): Promise<{ message: string; allowed: boolean }> {
  const state = await balances(context.company.id);
  const pocket = state.pockets.find(item => item.id === pending.pocketId);
  if (!pocket) return { message: `Não encontrei mais o cofrinho *${pending.pocketName}*.`, allowed: false };

  if (pending.direction === 'in') {
    if (pending.amount > state.available + 0.005) {
      return {
        allowed: false,
        message: [
          `🐷 Você quer guardar *${brl(pending.amount)}* no cofrinho *${pocket.name}*.`,
          `Hoje há *${brl(state.available)}* disponível fora dos cofrinhos.`,
          '',
          'Esse valor ultrapassa o disponível livre, então não movi nada.'
        ].join('\n')
      };
    }

    return {
      allowed: true,
      message: [
        confirmationPrompt ? `🐷 *Reserva no cofrinho ${pocket.name}*` : `🧮 *Simulação — cofrinho ${pocket.name}*`,
        `Valor: *${brl(pending.amount)}*`,
        `Disponível fora dos cofrinhos: ${brl(state.available)} → *${brl(state.available - pending.amount)}*`,
        `No cofrinho ${pocket.name}: ${brl(pocket.balance)} → *${brl(Number(pocket.balance) + pending.amount)}*`,
        `Saldo total: *${brl(state.total)}* — não muda.`,
        '',
        confirmationPrompt ? 'Responda *sim* para confirmar ou *não* para cancelar.' : 'Foi apenas uma simulação. Nenhum dinheiro foi movido.'
      ].join('\n')
    };
  }

  if (pending.amount > Number(pocket.balance) + 0.005) {
    return {
      allowed: false,
      message: [
        `🐷 O cofrinho *${pocket.name}* tem *${brl(Number(pocket.balance))}*.`,
        `Você pediu para liberar ${brl(pending.amount)}.`,
        '',
        confirmationPrompt ? 'Não fiz a retirada porque o valor é maior que o saldo do cofrinho.' : 'Essa retirada não seria possível porque o valor é maior que o saldo do cofrinho.'
      ].join('\n')
    };
  }

  return {
    allowed: true,
    message: [
      confirmationPrompt ? `🐷 *Retirada do cofrinho ${pocket.name}*` : `🧮 *Simulação — cofrinho ${pocket.name}*`,
      `Valor: *${brl(pending.amount)}*`,
      `No cofrinho ${pocket.name}: ${brl(pocket.balance)} → *${brl(Number(pocket.balance) - pending.amount)}*`,
      `Disponível fora dos cofrinhos: ${brl(state.available)} → *${brl(state.available + pending.amount)}*`,
      `Saldo total: *${brl(state.total)}* — não muda.`,
      '',
      confirmationPrompt ? 'Responda *sim* para confirmar ou *não* para cancelar.' : 'Foi apenas uma simulação. Nenhum dinheiro foi movido.'
    ].join('\n')
  };
}

export async function handleCashPocketTransfer(context: VerticalContext): Promise<VerticalResult | null> {
  const intent = parseCashPocketTransferIntent(context.combinedText);
  if (!intent) return await handleCashPocketAvailabilityQuery(context);

  const resolved = await resolvePocket(context);
  if (!resolved.pocket) return text(resolved.error ?? 'Qual cofrinho você quer usar?');

  const pending: PendingPocketTransfer = {
    pocketId: resolved.pocket.id,
    pocketName: resolved.pocket.name,
    direction: intent.direction,
    amount: intent.amount
  };

  if (intent.simulation) {
    const result = await preview(context, pending, false);
    return text(result.message);
  }

  const result = await preview(context, pending, true);
  if (!result.allowed) return text(result.message);

  await savePending(context, pending);
  return text(result.message);
}

function confirmation(value: string): boolean {
  const clean = normalize(value).replace(/[!.]+$/g, '').trim();
  return /^(sim|confirmo|confirmar|confirma|pode|pode fazer|faz|faca|faça|isso|isso mesmo|correto|ta certo|tá certo)$/.test(clean);
}

function cancellation(value: string): boolean {
  const clean = normalize(value).replace(/[!.]+$/g, '').trim();
  return /^(nao|não|cancelar|cancela|cancele|deixa pra la|deixa pra lá|esquece|nao faz|não faz)$/.test(clean);
}

function editedAmount(value: string): number | null {
  const clean = normalize(value);
  if (!/\b(valor|na verdade|melhor|troca|muda|corrige|ajusta)\b/.test(clean)) return null;
  return amountFrom(value);
}

export async function handleCashPendingPocketTransfer(context: VerticalContext): Promise<VerticalResult | undefined> {
  const pending = await getPending(context);
  if (!pending) return undefined;

  if (cancellation(context.combinedText)) {
    await clearPending(context);
    return text('Tudo bem 👍 Não movi nenhum dinheiro do/para o cofrinho.');
  }

  const nextAmount = editedAmount(context.combinedText);
  if (nextAmount) {
    pending.amount = nextAmount;
    const result = await preview(context, pending, true);
    if (!result.allowed) {
      await clearPending(context);
      return text(result.message);
    }
    await savePending(context, pending);
    return text(result.message);
  }

  if (!confirmation(context.combinedText)) {
    // Qualquer nova mensagem que não seja uma continuação explícita abandona a
    // confirmação antiga e segue para a OpenAI como uma intenção nova.
    await clearPending(context);
    return undefined;
  }

  const before = await preview(context, pending, true);
  if (!before.allowed) {
    await clearPending(context);
    return text(before.message);
  }

  const delta = pending.direction === 'in' ? pending.amount : -pending.amount;
  await cashPocketService.adjustAllocation(context.company.id, pending.pocketId, delta);
  await clearPending(context);

  const state = await balances(context.company.id);
  const pocket = state.pockets.find(item => item.id === pending.pocketId);
  return text([
    pending.direction === 'in'
      ? `✅ *${brl(pending.amount)} guardados no cofrinho ${pending.pocketName}.*`
      : `✅ *${brl(pending.amount)} liberados do cofrinho ${pending.pocketName}.*`,
    pocket ? `🐷 Cofrinho: ${brl(Number(pocket.balance))}` : '',
    `💳 Disponível fora dos cofrinhos: *${brl(state.available)}*`,
    `💰 Saldo total: ${brl(state.total)}`
  ].filter(Boolean).join('\n'));
}
