import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../infrastructure/db.js';
import { redis } from '../../infrastructure/redis.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashPocketService, normalizeCashPocketName } from './cofrinhos.js';
import {
  cashConversationMemorySize,
  loadCashConversationMemory
} from './conversation-memory.js';
import { getCashQueryContext } from './conversation-state.js';
import { cashService } from './service.js';

const TTL_SECONDS = 15 * 60;
const HISTORY_CONTEXT = '__cash_history__';
const RECORD_CATALOG_LIMIT = 40;

const DeletePlanSchema = z.object({
  target: z.enum(['records', 'pockets', 'records_and_pockets', 'unknown']),
  record_scope: z.enum(['specific', 'all', 'shown', 'none']),
  record_ids: z.array(z.string()).max(50),
  record_indices: z.array(z.number().int().min(1).max(100)).max(50),
  pocket_scope: z.enum(['named', 'all', 'none']),
  pocket_names: z.array(z.string()).max(20),
  clarification: z.string().nullable()
});

type DeletePlan = z.infer<typeof DeletePlanSchema>;

type PendingNaturalDeletion = {
  recordMode: 'all' | 'ids' | null;
  recordIds: string[];
  recordCount: number;
  pocketIds: string[];
  pocketNames: string[];
};

type RecordCatalogRow = {
  id: string;
  type: 'income' | 'expense';
  amount: number;
  category: string;
  merchant: string | null;
  description: string | null;
  transaction_date: string;
  created_at: string;
};

const client = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function phoneDigits(value: string): string {
  return String(value ?? '').replace(/\D/g, '');
}

function pendingKey(companyId: string, phone: string): string {
  return `arles:cash:ai-delete:${companyId}:${phoneDigits(phone)}`;
}

function estimatedNanoCostUsd(response: unknown): number {
  const usage = (response as any)?.usage;
  const input = Number(usage?.input_tokens ?? 0);
  const output = Number(usage?.output_tokens ?? 0);
  return (input * 0.05 + output * 0.40) / 1_000_000;
}

async function clearConflictingPending(context: VerticalContext): Promise<void> {
  const phone = phoneDigits(context.message.phone);
  await redis.del(
    `arles:cash:pending-pocket-transfer:${context.company.id}:${phone}`,
    `arles:cash:pocket-closing:${context.company.id}:${phone}`,
    `arles:cash:pending-deletion:${context.company.id}:${phone}`
  );
}

async function loadRecordCatalog(companyId: string): Promise<RecordCatalogRow[]> {
  const result = await db.query<RecordCatalogRow>(
    `select id::text,type,amount::float8,category,merchant,description,
            transaction_date::text,created_at::text
     from cash_transactions
     where company_id=$1
     order by transaction_date desc,created_at desc
     limit $2`,
    [companyId, RECORD_CATALOG_LIMIT]
  );
  return result.rows;
}

function recordCatalogText(rows: RecordCatalogRow[]): string {
  if (!rows.length) return '(nenhum registro ativo)';
  return rows.map((row, index) => JSON.stringify({
    recent_position: index + 1,
    id: row.id,
    type: row.type,
    amount: Number(row.amount),
    date: row.transaction_date,
    category: row.category,
    description: row.description,
    merchant: row.merchant
  })).join('\n');
}

async function planDeletion(
  context: VerticalContext,
  firstPassRewrite: string | null | undefined,
  firstStageEstimatedUsd: number
): Promise<DeletePlan | null> {
  if (!client) return null;

  const [pockets, lastQuery, memory, catalog] = await Promise.all([
    cashPocketService.list(context.company.id),
    getCashQueryContext(context.company.id, context.message.phone),
    loadCashConversationMemory(context.company.id, context.message.phone, cashConversationMemorySize),
    loadRecordCatalog(context.company.id)
  ]);

  const pocketNames = pockets.map(item => item.name).slice(0, 30);
  const recentContext = lastQuery === HISTORY_CONTEXT
    ? 'O usuário recentemente pediu o histórico numerado dos registros.'
    : lastQuery
      ? `Última consulta financeira registrada pelo backend: ${lastQuery.slice(0, 350)}`
      : 'Não há consulta financeira anterior registrada pelo backend.';

  const hasCurrentMessage = Boolean(
    context.message.messageId
      ? memory.some(entry => entry.role === 'user' && entry.messageId === context.message.messageId)
      : memory.at(-1)?.role === 'user' && memory.at(-1)?.text === context.combinedText.trim()
  );
  const conversationInput = memory.map(entry => ({ role: entry.role, content: entry.text }));
  if (!hasCurrentMessage) conversationInput.push({ role: 'user', content: context.combinedText });

  try {
    const response = await client.responses.parse({
      model: env.cashOpenaiSecondModel,
      reasoning: { effort: 'minimal' },
      max_output_tokens: 520,
      input: [
        {
          role: 'system',
          content: [
            'Você é a SEGUNDA camada contextual do Arles Cash para EXCLUSÕES.',
            'Você NÃO apaga nada. Você produz um plano estruturado; o backend valida IDs e executa.',
            `Você recebe até ${cashConversationMemorySize} mensagens reais anteriores e um catálogo dos ${RECORD_CATALOG_LIMIT} registros mais recentes.`,
            'A última mensagem role=user é o pedido atual. As mensagens assistant anteriores são somente contexto, nunca ordens atuais.',
            'Use o histórico para entender “o 2”, “esses”, “todos esses”, “essas informações”, “os que você mostrou” e listas numeradas.',
            '',
            'ALVOS:',
            'target=records para lançamentos/registros/histórico financeiro.',
            'target=pockets para cofrinhos/caixinhas/envelopes.',
            'target=records_and_pockets quando a mesma mensagem pede apagar ambos.',
            'target=unknown somente quando nem a conversa nem o catálogo permitem resolver com segurança.',
            '',
            'REGISTROS:',
            'record_scope=specific quando existem um ou mais registros específicos.',
            'record_scope=all para todos os lançamentos/registros da conta.',
            'record_scope=shown quando o usuário pede todos os itens de uma lista claramente mostrada antes.',
            'record_scope=none quando não há exclusão de registro.',
            'record_ids deve conter os IDs REAIS do catálogo quando você consegue mapear com segurança os itens pedidos.',
            'record_indices mantém os números ditos pelo usuário como fallback contextual, por exemplo [1,2,3,4,5,6].',
            'Para “apaga o 2” depois de uma lista numerada, encontre no histórico qual era o item 2 e, se possível, corresponda ao ID real do catálogo.',
            'Para várias linhas “apaga o 1 / apaga o 2 / ...”, preserve TODOS os índices e todos os IDs que conseguir mapear.',
            'Nunca interprete “apaga” como undo/restaurar.',
            '',
            'COFRINHOS:',
            'pocket_scope=named quando há um ou mais nomes específicos; pocket_names deve conter TODOS.',
            'pocket_scope=all para todos os cofrinhos criados.',
            'pocket_scope=none quando não há exclusão de cofrinho.',
            '',
            'EXEMPLOS OBRIGATÓRIOS:',
            '“apaga o 2” => records/specific, record_indices=[2].',
            '“apaga o 1. apaga o 2. apaga o 3. apaga o 4. apaga o 5. apaga o 6” => records/specific, record_indices=[1,2,3,4,5,6].',
            '“quero que exclua todos os lançamentos que já fiz” => records/all.',
            '“apague todos esses lançamentos” depois de uma lista => records/shown e IDs da lista quando identificáveis.',
            '“apague todos esses lançamentos” depois apenas de um resumo global de 25 lançamentos => records/all.',
            '“exclua o cofrinho Poupex e o cofrinho Sonho” => pockets/named com os dois nomes.',
            '“exclua todos os lançamentos e todos os cofrinhos” => records_and_pockets/all/all.',
            '',
            `Cofrinhos ativos: ${pocketNames.length ? pocketNames.join(' | ') : '(nenhum)'}`,
            recentContext,
            '',
            'CATÁLOGO DE REGISTROS REAIS (somente referência; não invente IDs fora dele):',
            recordCatalogText(catalog),
            '',
            firstPassRewrite?.trim()
              ? `A primeira IA reescreveu o pedido atual como: ${firstPassRewrite.trim()}`
              : 'A primeira IA não forneceu reescrita adicional.',
            'Se houver dúvida sobre QUAL registro seria apagado, target=unknown e clarification deve perguntar de forma curta.'
          ].join('\n')
        },
        ...conversationInput
      ],
      text: { format: zodTextFormat(DeletePlanSchema, 'cash_delete_plan') }
    });

    const usage = (response as any)?.usage;
    if (usage) {
      const second = estimatedNanoCostUsd(response);
      console.info(
        `[CashAI] stage=contextual_delete_plan model=${env.cashOpenaiSecondModel}` +
        ` memory_messages=${conversationInput.length}` +
        ` catalog_records=${catalog.length}` +
        ` message=${context.message.messageId || 'unknown'}` +
        ` input_tokens=${usage.input_tokens ?? 0}` +
        ` output_tokens=${usage.output_tokens ?? 0}` +
        ` estimated_usd=${second.toFixed(8)}` +
        ` estimated_total_usd=${(Math.max(0, firstStageEstimatedUsd) + second).toFixed(8)}`
      );
    }

    return response.output_parsed ?? null;
  } catch (error) {
    console.error('[CashAI] falha na segunda camada contextual de exclusão:', error);
    return null;
  }
}

async function countRecords(companyId: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    'select count(*)::int as count from cash_transactions where company_id=$1',
    [companyId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function historyIds(context: VerticalContext, limit = 5): Promise<string[]> {
  const rows = await cashService.listRecent(context.company.id, context.message.phone, limit);
  return rows.map((row: any) => String(row.id));
}

async function validateRecordIds(companyId: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  if (!unique.length) return [];
  const result = await db.query<{ id: string }>(
    `select id::text as id from cash_transactions
     where company_id=$1 and id::text = any($2::text[])`,
    [companyId, unique]
  );
  const valid = new Set(result.rows.map(row => row.id));
  return unique.filter(id => valid.has(id));
}

async function idsFromIndices(context: VerticalContext, indices: number[]): Promise<string[]> {
  const unique = [...new Set(indices.map(Number).filter(value => Number.isInteger(value) && value >= 1 && value <= 100))];
  if (!unique.length) return [];
  const maxIndex = Math.max(...unique);
  const rows = await cashService.listRecent(context.company.id, context.message.phone, Math.max(5, maxIndex));
  return unique
    .map(index => rows[index - 1])
    .filter(Boolean)
    .map((row: any) => String(row.id));
}

async function savePending(context: VerticalContext, pending: PendingNaturalDeletion): Promise<void> {
  await clearConflictingPending(context);
  await redis.set(
    pendingKey(context.company.id, context.message.phone),
    JSON.stringify(pending),
    'EX',
    TTL_SECONDS
  );
}

async function loadPending(context: VerticalContext): Promise<PendingNaturalDeletion | null> {
  const raw = await redis.get(pendingKey(context.company.id, context.message.phone));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingNaturalDeletion;
    if (!['all', 'ids', null].includes(parsed.recordMode as any)) return null;
    if (!Array.isArray(parsed.recordIds) || !Array.isArray(parsed.pocketIds) || !Array.isArray(parsed.pocketNames)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function clearPending(context: VerticalContext): Promise<void> {
  await redis.del(pendingKey(context.company.id, context.message.phone));
}

async function executePending(context: VerticalContext, pending: PendingNaturalDeletion): Promise<{ records: number; pockets: number }> {
  const sql = await db.connect();
  let records = 0;
  let pockets = 0;
  try {
    await sql.query('begin');

    if (pending.recordMode === 'all') {
      const deleted = await sql.query('delete from cash_transactions where company_id=$1 returning id', [context.company.id]);
      records = Number(deleted.rowCount ?? 0);
    } else if (pending.recordMode === 'ids' && pending.recordIds.length) {
      const deleted = await sql.query(
        'delete from cash_transactions where company_id=$1 and id::text = any($2::text[]) returning id',
        [context.company.id, pending.recordIds]
      );
      records = Number(deleted.rowCount ?? 0);
    }

    for (const pocketId of pending.pocketIds) {
      const current = await sql.query(
        'select 1 from cash_pockets where company_id=$1 and id::text=$2 and active=true for update',
        [context.company.id, pocketId]
      );
      if (!current.rowCount) continue;

      await sql.query(
        'update cash_transactions set pocket_id=null where company_id=$1 and pocket_id::text=$2',
        [context.company.id, pocketId]
      );
      await sql.query(
        'update cash_scheduled_forecasts set pocket_id=null,updated_at=now() where company_id=$1 and pocket_id::text=$2',
        [context.company.id, pocketId]
      );
      await sql.query(
        'update cash_pockets set active=false,updated_at=now() where company_id=$1 and id::text=$2',
        [context.company.id, pocketId]
      );
      pockets += 1;
    }

    await sql.query(
      `update companies set monthly_contacts_used=(
         select count(*)::int from cash_transactions
         where company_id=$1
           and transaction_date >= date_trunc('month',current_date)::date
           and transaction_date < (date_trunc('month',current_date)+interval '1 month')::date
       ),updated_at=now() where id=$1`,
      [context.company.id]
    );

    await sql.query('commit');
    return { records, pockets };
  } catch (error) {
    await sql.query('rollback');
    throw error;
  } finally {
    sql.release();
  }
}

function confirmationPrompt(pending: PendingNaturalDeletion): VerticalResult {
  const lines = ['⚠️ *Confirme a exclusão*'];
  if (pending.recordCount > 0) {
    lines.push(`🗑️ Registros: ${pending.recordMode === 'all' ? `todos (${pending.recordCount})` : pending.recordCount}`);
  }
  if (pending.pocketIds.length) {
    lines.push(`🐷 Cofrinhos: ${pending.pocketNames.join(', ')}`);
  }
  lines.push('', 'Essa ação não pode ser desfeita.', 'Responda *sim* para apagar ou *não* para cancelar.');
  return text(lines.join('\n'));
}

async function resolveNamedPockets(companyId: string, requested: string[]) {
  const active = await cashPocketService.list(companyId);
  const byName = new Map(active.map(item => [normalizeCashPocketName(item.name), item]));
  const selected = [] as typeof active;
  const missing: string[] = [];

  for (const raw of requested) {
    const key = normalizeCashPocketName(raw);
    const pocket = byName.get(key);
    if (!pocket) {
      missing.push(raw);
      continue;
    }
    if (!selected.some(item => item.id === pocket.id)) selected.push(pocket);
  }
  return { selected, missing, active };
}

export async function executeCashAiDeletion(
  context: VerticalContext,
  firstPassRewrite?: string | null,
  firstStageEstimatedUsd = 0
): Promise<VerticalResult | null> {
  const plan = await planDeletion(context, firstPassRewrite, firstStageEstimatedUsd);
  if (!plan) {
    return client
      ? text('Não consegui montar a exclusão com segurança agora. Pode repetir o pedido?')
      : null;
  }
  if (plan.target === 'unknown') {
    return text(plan.clarification?.trim() || 'Quais registros ou cofrinhos exatamente você quer apagar?');
  }

  await clearConflictingPending(context);

  let recordMode: PendingNaturalDeletion['recordMode'] = null;
  let recordIds: string[] = [];
  let recordCount = 0;

  if (plan.target === 'records' || plan.target === 'records_and_pockets') {
    if (plan.record_scope === 'all') {
      recordMode = 'all';
      recordCount = await countRecords(context.company.id);
    } else if (plan.record_scope === 'specific') {
      const aiIds = await validateRecordIds(context.company.id, plan.record_ids);
      const fallbackIds = aiIds.length ? [] : await idsFromIndices(context, plan.record_indices);
      recordIds = [...new Set([...aiIds, ...fallbackIds])];
      if (!recordIds.length) {
        return text('Não consegui identificar com segurança quais registros você apontou. Mande *histórico* e repita usando os números da lista.');
      }
      recordMode = 'ids';
      recordCount = recordIds.length;
    } else if (plan.record_scope === 'shown') {
      const aiIds = await validateRecordIds(context.company.id, plan.record_ids);
      recordIds = aiIds.length ? aiIds : await historyIds(context, 5);
      if (!recordIds.length) return text('Não há registros recentes identificáveis para apagar.');
      recordMode = 'ids';
      recordCount = recordIds.length;
    }
  }

  let pocketIds: string[] = [];
  let pocketNames: string[] = [];
  if (plan.target === 'pockets' || plan.target === 'records_and_pockets') {
    const resolved = await resolveNamedPockets(context.company.id, plan.pocket_names);
    if (plan.pocket_scope === 'all') {
      pocketIds = resolved.active.map(item => String(item.id));
      pocketNames = resolved.active.map(item => item.name);
    } else if (plan.pocket_scope === 'named') {
      if (resolved.missing.length) {
        return text(`Não encontrei estes cofrinhos: ${resolved.missing.join(', ')}.`);
      }
      pocketIds = resolved.selected.map(item => String(item.id));
      pocketNames = resolved.selected.map(item => item.name);
    }

    if (!pocketIds.length && plan.target === 'pockets') {
      return text('Não encontrei nenhum cofrinho ativo correspondente ao seu pedido.');
    }
  }

  if (recordMode === 'all' && recordCount === 0 && !pocketIds.length) {
    return text('Você não tem registros para apagar.');
  }

  if (!recordMode && !pocketIds.length) {
    return text(plan.clarification?.trim() || 'Não consegui identificar com segurança o que deve ser apagado.');
  }

  // Uma única exclusão específica continua imediata. Qualquer lote, combinação ou
  // exclusão total exige confirmação explícita antes de tocar no banco.
  if (recordMode === 'ids' && recordIds.length === 1 && !pocketIds.length && plan.target === 'records') {
    const done = await executePending(context, {
      recordMode,
      recordIds,
      recordCount: 1,
      pocketIds: [],
      pocketNames: []
    });
    return text(done.records === 1 ? '🗑️ Registro apagado.' : 'Esse registro já não existe mais.');
  }

  if (!recordMode && pocketIds.length === 1 && plan.target === 'pockets') {
    const done = await executePending(context, {
      recordMode: null,
      recordIds: [],
      recordCount: 0,
      pocketIds,
      pocketNames
    });
    return text(done.pockets === 1 ? `🐷 Cofrinho *${pocketNames[0]}* apagado.` : 'Esse cofrinho já não estava ativo.');
  }

  const pending: PendingNaturalDeletion = {
    recordMode,
    recordIds,
    recordCount,
    pocketIds,
    pocketNames
  };
  await savePending(context, pending);
  return confirmationPrompt(pending);
}

function normalizedReply(value: string): string {
  return String(value ?? '').trim().toLocaleLowerCase('pt-BR');
}

function isConfirmation(value: string): boolean {
  return new Set(['sim', 'confirmo', 'pode', 'pode apagar', 'apaga', 'isso mesmo', 'correto']).has(normalizedReply(value));
}

function isCancellation(value: string): boolean {
  return new Set(['não', 'nao', 'n', 'cancela', 'cancelar', 'deixa pra lá', 'deixa pra la', 'não apaga', 'nao apaga']).has(normalizedReply(value));
}

export async function handleCashPendingAiDeletion(context: VerticalContext): Promise<VerticalResult | undefined> {
  const pending = await loadPending(context);
  if (!pending) return undefined;

  if (isCancellation(context.combinedText)) {
    await clearPending(context);
    return text('Tudo bem 👍 Não apaguei nada.');
  }

  if (!isConfirmation(context.combinedText)) {
    // Qualquer mensagem nova que não seja confirmação/cancelamento explícito abandona
    // o estado antigo e segue para a IA contextual como uma nova intenção.
    await clearPending(context);
    return undefined;
  }

  const done = await executePending(context, pending);
  await clearPending(context);
  const parts: string[] = ['🗑️ Exclusão concluída.'];
  if (pending.recordMode) parts.push(`Registros apagados: ${done.records}.`);
  if (pending.pocketIds.length) parts.push(`Cofrinhos apagados: ${done.pockets}.`);
  return text(parts.join('\n'));
}

export const cashHistoryContextMarker = HISTORY_CONTEXT;
