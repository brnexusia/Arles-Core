import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashPocketService, normalizeCashPocketName } from './cofrinhos.js';
import { handleCashPocketClosing, isCashPocketClosingMessage } from './pocket-closing.js';
import { normalizeCashPocketLanguage } from './pocket-language.js';

const PENDING_TTL_SECONDS = 30 * 60;

type PendingClosing = {
  sourceText: string;
  sourceMessageId: string | null;
  requestedName: string | null;
};

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

function phoneKey(phone: string): string {
  return String(phone ?? '').replace(/\D/g, '');
}

function pendingKey(companyId: string, phone: string): string {
  return `arles:cash:pocket-closing:${companyId}:${phoneKey(phone)}`;
}

async function redisClient() {
  return (await import('../../infrastructure/redis.js')).redis;
}

async function savePending(context: VerticalContext, pending: PendingClosing): Promise<void> {
  const redis = await redisClient();
  await redis.set(
    pendingKey(context.company.id, context.message.phone),
    JSON.stringify(pending),
    'EX',
    PENDING_TTL_SECONDS
  );
}

async function loadPending(context: VerticalContext): Promise<PendingClosing | null> {
  const redis = await redisClient();
  const raw = await redis.get(pendingKey(context.company.id, context.message.phone));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingClosing;
    if (!parsed?.sourceText) return null;
    return {
      sourceText: String(parsed.sourceText),
      sourceMessageId: parsed.sourceMessageId ? String(parsed.sourceMessageId) : null,
      requestedName: parsed.requestedName ? String(parsed.requestedName) : null
    };
  } catch {
    return null;
  }
}

async function clearPending(context: VerticalContext): Promise<void> {
  const redis = await redisClient();
  await redis.del(pendingKey(context.company.id, context.message.phone));
}

export function extractRequestedClosingPocketName(input: string): string | null {
  const canonical = normalizeCashPocketLanguage(input);
  const matches = [...canonical.matchAll(
    /\bcofrinho\s+(?:(?:de|do|da|chamad[oa])\s+)?["'“”]?([A-Za-zÀ-ÖØ-öø-ÿ0-9][A-Za-zÀ-ÖØ-öø-ÿ0-9 _-]{0,79})["'“”]?/gi
  )];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const raw = String(matches[index]?.[1] ?? '')
      .replace(/\s+(?:para|pra)\s+(?:registrar|salvar|guardar|fechar)\b.*$/i, '')
      .replace(/\s+e\s+(?:registre|registra|salve|salva|anote|anota)\b.*$/i, '')
      .trim();
    const normalizedName = normalizeCashPocketName(raw);
    if (!normalizedName) continue;
    return raw.replace(/\s+/g, ' ').trim();
  }
  return null;
}

function replyPocketName(input: string): string | null {
  const canonical = normalizeCashPocketLanguage(input).trim();
  const explicit = canonical.match(/^(?:usar|use|no|na|pro|pra|para o|cofrinho|criar|crie|novo cofrinho|criar cofrinho)\s+(?:cofrinho\s+)?(?:de\s+)?(.+)$/i)?.[1];
  const raw = String(explicit ?? canonical)
    .replace(/^["'“”]+|["'“”.,!?;:()]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw || raw.split(/\s+/).length > 6 || /\d/.test(raw)) return null;
  if (/^(sim|s|nao|não|n|cancela|cancelar|ok|certo|beleza)$/i.test(raw)) return null;

  // Um fechamento pendente não pode sequestrar um novo comando financeiro e tratar
  // “saldo”, “gastei 50” ou “meus cofrinhos” como se fossem nomes de cofrinho.
  const value = normalize(raw);
  if (/\b(saldo|extrato|historico|relatorio|resumo|ajuda|menu|planos?|trial|categorias?|gastei|paguei|comprei|recebi|ganhei|entrou|faturei|quanto|quais|meus cofrinhos)\b/.test(value)) {
    return null;
  }
  return raw.slice(0, 80);
}

function isYes(input: string): boolean {
  return /^(sim|s|isso|pode|pode criar|cria|crie|confirmo|quero|quero sim|sim pode)$/i.test(normalize(input));
}

function isNo(input: string): boolean {
  return /^(nao|não|n|cancela|cancelar|deixa|deixa pra la|deixa para la)$/i.test(normalize(input));
}

async function pocketListMessage(context: VerticalContext, requestedName: string | null): Promise<string> {
  const pockets = await cashPocketService.list(context.company.id);
  const existing = pockets.length
    ? ['Seus cofrinhos atuais:', ...pockets.map(item => `• ${item.name}`)].join('\n')
    : 'Você ainda não tem nenhum cofrinho criado.';

  if (requestedName) {
    return [
      `Não encontrei o cofrinho *${requestedName}*.`,
      existing,
      '',
      `Quer que eu crie *${requestedName}* e já registre este fechamento nele?`,
      'Responda *sim* para criar ou diga o nome de outro cofrinho.'
    ].join('\n');
  }

  return [
    'Em qual cofrinho devo registrar este fechamento?',
    existing,
    '',
    'Diga o nome de um deles. Se você informar um nome que ainda não existe, eu pergunto se quer criá-lo.'
  ].join('\n');
}

async function replayClosing(
  context: VerticalContext,
  pending: PendingClosing,
  pocketName: string
): Promise<VerticalResult | null> {
  const replayText = `${pending.sourceText}\n\nRegistre essas informações no cofrinho ${pocketName}.`;
  const replayContext: VerticalContext = {
    ...context,
    combinedText: replayText,
    message: {
      ...context.message,
      messageId: pending.sourceMessageId || context.message.messageId
    }
  };
  return await handleCashPocketClosing(replayContext);
}

/**
 * Entrada inicial de um fechamento. Resolve o cofrinho citado quando ele existe e,
 * quando não existe ou não foi informado, persiste o contexto para a próxima resposta.
 */
export async function handleCashPocketClosingFlow(context: VerticalContext): Promise<VerticalResult | null> {
  if (!isCashPocketClosingMessage(context.combinedText)) return null;

  const requestedName = extractRequestedClosingPocketName(context.combinedText);
  if (requestedName) {
    const existing = await cashPocketService.findByName(context.company.id, requestedName);
    if (existing) {
      return await replayClosing(context, {
        sourceText: context.combinedText,
        sourceMessageId: context.message.messageId || null,
        requestedName: existing.name
      }, existing.name);
    }
  }

  await savePending(context, {
    sourceText: context.combinedText,
    sourceMessageId: context.message.messageId || null,
    requestedName
  });
  return text(await pocketListMessage(context, requestedName));
}

/**
 * Continuação de um fechamento pendente. Permite escolher um cofrinho existente ou
 * criar o nome solicitado com um simples “sim”, sem exigir que o usuário repita os dados.
 */
export async function handleCashPendingPocketClosing(context: VerticalContext): Promise<VerticalResult | null> {
  const pending = await loadPending(context);
  if (!pending) return null;

  if (isNo(context.combinedText)) {
    await clearPending(context);
    return text('Certo. Não criei cofrinho e não registrei esse fechamento.');
  }

  if (isYes(context.combinedText)) {
    if (!pending.requestedName) {
      return text(await pocketListMessage(context, null));
    }
    const created = await cashPocketService.create(context.company.id, pending.requestedName);
    const result = await replayClosing(context, pending, created.pocket.name);
    await clearPending(context);
    return result ?? text(`🐷 Cofrinho *${created.pocket.name}* criado, mas não consegui concluir o fechamento. Pode reenviar os dados.`);
  }

  const candidate = replyPocketName(context.combinedText);
  if (!candidate) return null;

  const existing = await cashPocketService.findByName(context.company.id, candidate);
  if (existing) {
    const result = await replayClosing(context, pending, existing.name);
    await clearPending(context);
    return result ?? text(`Encontrei o cofrinho *${existing.name}*, mas não consegui concluir o fechamento. Pode reenviar os dados.`);
  }

  pending.requestedName = candidate;
  await savePending(context, pending);
  return text(await pocketListMessage(context, candidate));
}