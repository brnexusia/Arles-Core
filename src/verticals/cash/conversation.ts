import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { redis } from '../../infrastructure/redis.js';
import type { VerticalContext, VerticalHandler, VerticalResult } from '../vertical.js';
import { cashHandler } from './handler.js';
import { cashService } from './service.js';
import { deletionTarget, normalizeCashText, type CashRecordTarget } from './management.js';
import { formatBrazilDate, isoBrazil } from './time.js';

const CONTEXT_TTL_SECONDS = 30 * 60;
const MONTHS = 'janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';

const FallbackSchema = z.object({
  intent: z.enum(['query', 'help', 'undo', 'unknown']),
  rewritten_text: z.string().nullable()
});

type DeletedSnapshot = {
  id: string;
  type: 'income' | 'expense';
  amount: number;
  category: string;
  merchant: string | null;
  description: string | null;
  transaction_date: string;
};

const fallbackClient = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;

function key(kind: 'query' | 'deleted', companyId: string, phone: string): string {
  return `arles:cash:${kind}:${companyId}:${phone.replace(/\D/g, '')}`;
}

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function resultText(result: VerticalResult | null): string {
  if (!result) return '';
  return result.actions
    .filter(action => action.type === 'text')
    .map(action => action.type === 'text' ? action.text : '')
    .join('\n');
}

function isQueryResult(result: VerticalResult | null): boolean {
  return resultText(result).trimStart().startsWith('🔎');
}

function isGenericFallback(result: VerticalResult | null): boolean {
  return resultText(result).trimStart().startsWith('Hmm, não entendi bem');
}

export function isGuideRequest(input: string): boolean {
  const value = normalizeCashText(input);
  return /^(ajuda|menu|comandos|guia|guia de ajuda|tutorial|me ajuda|me ensina|como usar|como uso|o que voce faz|o que posso fazer|como funciona)[!.? ]*$/.test(value);
}

export function isUndoRequest(input: string): boolean {
  const value = normalizeCashText(input);
  return /^(?:desfaz|desfazer|volta|restaura|restaurar|recupera|recuperar)(?:\s+(?:o|a|isso|ultimo|último|registro|registo|exclusao|exclusão))?[!.? ]*$/.test(value)
    || /^(?:coloca|bota|poe|põe|adiciona)(?:\s+(?:ele|isso|o registro|o registo))?\s+(?:de novo|novamente)[!.? ]*$/.test(value);
}

function isTemporalFollowup(input: string): boolean {
  const value = normalizeCashText(input);
  return new RegExp(
    `^(?:e\\s+)?(?:(?:hoje|ontem|anteontem)|(?:esta|essa|ultima|última|passada|atual)\\s+semana|semana\\s+(?:passada|atual)|(?:este|esse|ultimo|último|passado|atual)\\s+m[eê]s|m[eê]s\\s+(?:passado|atual)|(?:este|esse|ultimo|último|passado|atual)\\s+ano|ano\\s+(?:passado|atual)|(?:em\\s+)?(?:${MONTHS})(?:\\s+de\\s+20\\d{2})?)[!.? ]*$`,
    'i'
  ).test(value);
}

function stripKnownPeriod(input: string): string {
  return input
    .replace(/\b(hoje|ontem|anteontem)\b/gi, ' ')
    .replace(/\b(esta|essa|ultima|última|passada|atual)\s+semana\b/gi, ' ')
    .replace(/\bsemana\s+(passada|atual)\b/gi, ' ')
    .replace(/\b(este|esse|ultimo|último|passado|atual)\s+m[eê]s\b/gi, ' ')
    .replace(/\bm[eê]s\s+(passado|atual)\b/gi, ' ')
    .replace(/\b(este|esse|ultimo|último|passado|atual)\s+ano\b/gi, ' ')
    .replace(/\bano\s+(passado|atual)\b/gi, ' ')
    .replace(new RegExp(`\\b(?:em\\s+)?(?:${MONTHS})(?:\\s+de\\s+20\\d{2})?\\b`, 'gi'), ' ')
    .replace(/[?!.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function expandQueryFollowup(previous: string, current: string): string | null {
  if (!previous.trim() || !isTemporalFollowup(current)) return null;
  const period = current.replace(/^\s*e\s+/i, '').trim();
  const base = stripKnownPeriod(previous);
  if (!base) return null;
  return `${base} ${period}`.replace(/\s+/g, ' ').trim();
}

export function toIsoDateOnly(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }
  const raw = String(value ?? '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}-${String(parsed.getUTCDate()).padStart(2, '0')}`;
  }
  return isoBrazil();
}

function recordLabel(row: DeletedSnapshot): string {
  const icon = row.type === 'income' ? '💰' : '💸';
  const amount = Number(row.amount).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const description = row.description?.trim() || row.merchant?.trim() || row.category;
  return `${icon} ${amount} — ${description} · ${formatBrazilDate(row.transaction_date)}`;
}

function helpGuide(): string {
  return [
    '💡 Guia rápido do Arles Cash',
    '',
    '💸 Registrar despesa',
    '“gastei 50 no mercado”',
    '“comprei uma blusinha na SHEIN de 15 reais”',
    '',
    '💰 Registrar receita',
    '“recebi 2000 de salário”',
    '',
    '🔎 Consultar e pesquisar',
    '“quanto gastei hoje?”',
    '“quanto gastei na SHEIN esse mês?”',
    '“quais foram meus registros de ontem?”',
    'Depois de uma consulta, pode continuar com “e ontem?” ou “e mês passado?”.',
    '',
    '📊 Saldo → “saldo”',
    '📋 Histórico → “histórico”',
    '✏️ Editar → “edita o último” ou “edita o 2”',
    '🗑️ Remover → “apaga o último” ou “remove o 2”',
    '↩️ Desfazer exclusão → “coloca ele de novo”',
    '📅 Relatório semanal → “relatório semanal”',
    '📅 Relatório mensal → “relatório mensal”',
    '',
    'Pode escrever de forma natural. Se uma frase não bater nas regras diretas, eu tento interpretar com IA antes de pedir para reformular.'
  ].join('\n');
}

async function rememberQuery(companyId: string, phone: string, query: string): Promise<void> {
  await redis.set(key('query', companyId, phone), query.slice(0, 1000), 'EX', CONTEXT_TTL_SECONDS);
}

async function getLastQuery(companyId: string, phone: string): Promise<string | null> {
  return await redis.get(key('query', companyId, phone));
}

async function rememberDeleted(companyId: string, phone: string, row: any): Promise<void> {
  const snapshot: DeletedSnapshot = {
    id: String(row.id),
    type: row.type === 'income' ? 'income' : 'expense',
    amount: Number(row.amount),
    category: String(row.category || 'Outros'),
    merchant: row.merchant == null ? null : String(row.merchant),
    description: row.description == null ? null : String(row.description),
    transaction_date: toIsoDateOnly(row.transaction_date)
  };
  await redis.set(key('deleted', companyId, phone), JSON.stringify(snapshot), 'EX', CONTEXT_TTL_SECONDS);
}

async function getDeleted(companyId: string, phone: string): Promise<DeletedSnapshot | null> {
  const raw = await redis.get(key('deleted', companyId, phone));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DeletedSnapshot;
  } catch {
    return null;
  }
}

async function clearDeleted(companyId: string, phone: string): Promise<void> {
  await redis.del(key('deleted', companyId, phone));
}

async function resolveDeleteSnapshot(companyId: string, phone: string, target: CashRecordTarget): Promise<any | null> {
  const rows = await cashService.listRecent(companyId, phone, target.kind === 'index' ? Math.max(5, target.index) : 1);
  if (target.kind === 'last') return rows[0] ?? null;
  return rows[target.index - 1] ?? null;
}

async function restoreDeleted(context: VerticalContext): Promise<VerticalResult> {
  const snapshot = await getDeleted(context.company.id, context.message.phone);
  if (!snapshot) {
    return text('Não tenho uma exclusão recente para desfazer. Se quiser conferir seus lançamentos, mande “histórico”.');
  }

  const restored = await cashService.createTransaction({
    companyId: context.company.id,
    phone: context.message.phone,
    sourceMessageId: `cash-restore:${snapshot.id}:${context.message.messageId || Date.now()}`,
    sourceMessage: 'Registro restaurado pelo usuário',
    transaction: {
      type: snapshot.type,
      amount: snapshot.amount,
      category: snapshot.type === 'income' ? 'Receita' : snapshot.category,
      merchant: snapshot.merchant ?? '',
      description: snapshot.description ?? '',
      transactionDate: snapshot.transaction_date
    }
  });
  await clearDeleted(context.company.id, context.message.phone);

  const restoredSnapshot: DeletedSnapshot = {
    ...snapshot,
    id: String(restored.id),
    transaction_date: toIsoDateOnly(restored.transaction_date)
  };
  return text(['↩️ Registro restaurado!', recordLabel(restoredSnapshot)].join('\n'));
}

async function aiFallback(input: string, lastQuery: string | null, hasDeleted: boolean) {
  if (!fallbackClient) return { intent: 'unknown' as const, rewritten_text: null as string | null };
  try {
    const response = await fallbackClient.responses.parse({
      model: env.openaiModel,
      input: [
        {
          role: 'system',
          content: [
            'Você é o classificador de fallback do Arles Cash, um assistente financeiro pessoal no WhatsApp.',
            'Você NÃO calcula valores nem inventa lançamentos. Apenas identifica qual ação suportada o usuário quis executar.',
            'intent=query quando a pessoa quer consultar dados financeiros já registrados. Reescreva rewritten_text como uma pergunta explícita que o mecanismo de busca entenda.',
            'intent=help quando a pessoa pergunta o que o sistema faz, como usar ou quais comandos existem.',
            'intent=undo quando a pessoa quer restaurar/desfazer o último registro excluído.',
            'intent=unknown para conversa sem relação com essas ações ou quando não for seguro inferir.',
            'Use o contexto da consulta anterior para mensagens curtas como “e ontem?”, “e na SHEIN?”, “e mês passado?”.',
            lastQuery ? `Consulta anterior: ${lastQuery}` : 'Não há consulta anterior disponível.',
            hasDeleted ? 'Existe um registro excluído recentemente que pode ser restaurado.' : 'Não há exclusão recente disponível.',
            'Nunca transforme uma frase ambígua em lançamento financeiro; lançamentos são tratados por outro parser.'
          ].join('\n')
        },
        { role: 'user', content: input }
      ],
      text: { format: zodTextFormat(FallbackSchema, 'cash_fallback') }
    });
    return response.output_parsed ?? { intent: 'unknown' as const, rewritten_text: null };
  } catch (error) {
    console.error('[CashConversation] falha no fallback de IA:', error);
    return { intent: 'unknown' as const, rewritten_text: null };
  }
}

export class CashConversationHandler implements VerticalHandler {
  async handle(context: VerticalContext): Promise<VerticalResult | null> {
    const { company, message, combinedText } = context;

    if (isGuideRequest(combinedText)) return text(helpGuide());
    if (isUndoRequest(combinedText)) return await restoreDeleted(context);

    const lastQuery = await getLastQuery(company.id, message.phone);
    const expanded = lastQuery ? expandQueryFollowup(lastQuery, combinedText) : null;
    const effectiveContext = expanded ? { ...context, combinedText: expanded } : context;

    const deleteTarget = deletionTarget(effectiveContext.combinedText);
    const deleteSnapshot = deleteTarget
      ? await resolveDeleteSnapshot(company.id, message.phone, deleteTarget)
      : null;

    const result = await cashHandler.handle(effectiveContext);

    if (isQueryResult(result)) {
      await rememberQuery(company.id, message.phone, effectiveContext.combinedText);
      return result;
    }

    if (deleteSnapshot && resultText(result).trimStart().startsWith('🗑️ Registro excluído:')) {
      await rememberDeleted(company.id, message.phone, deleteSnapshot);
      const snapshot: DeletedSnapshot = {
        id: String(deleteSnapshot.id),
        type: deleteSnapshot.type === 'income' ? 'income' : 'expense',
        amount: Number(deleteSnapshot.amount),
        category: String(deleteSnapshot.category || 'Outros'),
        merchant: deleteSnapshot.merchant == null ? null : String(deleteSnapshot.merchant),
        description: deleteSnapshot.description == null ? null : String(deleteSnapshot.description),
        transaction_date: toIsoDateOnly(deleteSnapshot.transaction_date)
      };
      return text([
        '🗑️ Registro excluído:',
        recordLabel(snapshot),
        '',
        'Feito! Se quiser desfazer, diga “coloca ele de novo”.'
      ].join('\n'));
    }

    if (!isGenericFallback(result)) return result;

    const deleted = await getDeleted(company.id, message.phone);
    const fallback = await aiFallback(combinedText, lastQuery, Boolean(deleted));

    if (fallback.intent === 'undo') return await restoreDeleted(context);
    if (fallback.intent === 'help') return text(helpGuide());
    if (fallback.intent === 'query' && fallback.rewritten_text?.trim()) {
      const retryContext = { ...context, combinedText: fallback.rewritten_text.trim() };
      const retry = await cashHandler.handle(retryContext);
      if (isQueryResult(retry)) {
        await rememberQuery(company.id, message.phone, retryContext.combinedText);
        return retry;
      }
    }

    return text([
      'Não consegui interpretar isso com segurança 🤔',
      '',
      helpGuide()
    ].join('\n'));
  }
}

export const cashConversationHandler = new CashConversationHandler();
