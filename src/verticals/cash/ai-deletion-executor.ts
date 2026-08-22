import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../infrastructure/db.js';
import { redis } from '../../infrastructure/redis.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashPocketService, normalizeCashPocketName } from './cofrinhos.js';
import { getCashQueryContext } from './conversation-state.js';
import { handleCashBulkDeletionCommand } from './deletion.js';
import { cashService } from './service.js';

const TTL_SECONDS = 15 * 60;
const HISTORY_CONTEXT = '__cash_history__';

const DeletePlanSchema = z.object({
  target: z.enum(['records', 'pockets', 'records_and_pockets', 'unknown']),
  record_scope: z.enum(['one', 'all', 'shown', 'none']),
  record_index: z.number().int().min(1).max(100).nullable(),
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

async function planDeletion(
  context: VerticalContext,
  firstPassRewrite: string | null | undefined,
  firstStageEstimatedUsd: number
): Promise<DeletePlan | null> {
  if (!client) return null;

  const [pockets, lastQuery] = await Promise.all([
    cashPocketService.list(context.company.id),
    getCashQueryContext(context.company.id, context.message.phone)
  ]);
  const pocketNames = pockets.map(item => item.name).slice(0, 30);
  const recentContext = lastQuery === HISTORY_CONTEXT
    ? 'O usuário acabou de ver o histórico/lista dos últimos registros.'
    : lastQuery
      ? `Última consulta/lista financeira: ${lastQuery.slice(0, 350)}`
      : 'Não há uma lista financeira recente registrada.';

  try {
    const response = await client.responses.parse({
      model: env.cashOpenaiSecondModel,
      reasoning: { effort: 'minimal' },
      max_output_tokens: 320,
      input: [
        {
          role: 'system',
          content: [
            'Você é a SEGUNDA camada de compreensão do Arles Cash para EXCLUSÕES.',
            'Você NÃO apaga nada. Apenas transforma a solicitação em um plano estruturado para o backend.',
            'target=records para lançamentos/registros/histórico financeiro.',
            'target=pockets para cofrinhos/caixinhas/envelopes.',
            'target=records_and_pockets quando a mesma mensagem pede apagar os dois grupos.',
            'record_scope=one quando existe um item específico, como “apaga o 2”; coloque o número em record_index.',
            'record_scope=all para “todos os lançamentos”, “todo meu histórico”, “tudo que registrei”.',
            'record_scope=shown para “apaga esses”, “apague todas essas informações”, “delete o que você acabou de mostrar” quando houver uma lista recente.',
            'pocket_scope=named quando a pessoa cita um ou mais cofrinhos pelo nome; pocket_names deve conter TODOS os nomes citados.',
            'pocket_scope=all para “todos os cofrinhos que fiz/criei”.',
            'Nunca confunda “apaga o 2” com desfazer exclusão. Desfazer é “restaura”, “coloca ele de novo”, “desfaz”.',
            'Nunca trate uma confirmação pendente antiga como prioridade sobre um novo comando explícito.',
            'Exemplos obrigatórios:',
            '“apaga o 2” => records / one / index 2.',
            '“quero que apague todos os lançamentos que fiz anteriormente” => records / all.',
            '“apague todas essas informações” após uma lista => records / shown.',
            '“exclua o cofrinho Poupex e o cofrinho Sonho” => pockets / named / [Poupex, Sonho].',
            '“exclua todos os lançamentos e delete todos os cofrinhos que fiz” => records_and_pockets / record_scope=all / pocket_scope=all.',
            `Cofrinhos ativos disponíveis: ${pocketNames.length ? pocketNames.join(' | ') : '(nenhum)'}`,
            recentContext,
            'Se a intenção destrutiva não estiver clara, use target=unknown e faça uma clarification curta.'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            `Mensagem original: ${context.combinedText}`,
            firstPassRewrite?.trim() ? `Reescrita da primeira IA: ${firstPassRewrite.trim()}` : ''
          ].filter(Boolean).join('\n')
        }
      ],
      text: { format: zodTextFormat(DeletePlanSchema, 'cash_delete_plan') }
    });

    const usage = (response as any)?.usage;
    if (usage) {
      const second = estimatedNanoCostUsd(response);
      console.info(
        `[CashAI] stage=delete_plan model=${env.cashOpenaiSecondModel}` +
        ` message=${context.message.messageId || 'unknown'}` +
        ` input_tokens=${usage.input_tokens ?? 0}` +
        ` output_tokens=${usage.output_tokens ?? 0}` +
        ` estimated_usd=${second.toFixed(8)}` +
        ` estimated_total_usd=${(Math.max(0, firstStageEstimatedUsd) + second).toFixed(8)}`
      );
    }

    return response.output_parsed ?? null;
  } catch (error) {
    console.error('[CashAI] falha na segunda camada de exclusão:', error);
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
  if (!plan) return null;
  if (plan.target === 'unknown') {
    return plan.clarification?.trim() ? text(plan.clarification.trim()) : null;
  }

  await clearConflictingPending(context);

  let recordMode: PendingNaturalDeletion['recordMode'] = null;
  let recordIds: string[] = [];
  let recordCount = 0;

  if (plan.target === 'records' || plan.target === 'records_and_pockets') {
    if (plan.record_scope === 'one') {
      const index = plan.record_index ?? 1;
      const lastContext = await getCashQueryContext(context.company.id, context.message.phone);
      const rows = await cashService.listRecent(context.company.id, context.message.phone, Math.max(5, index));
      const row = rows[index - 1];
      if (!row) return text(`Não encontrei o registro ${index}. Mande *histórico* para ver a numeração atual.`);

      // Exclusão unitária continua direta; confirmação fica só para ações em lote.
      await cashService.deleteTransaction(context.company.id, String((row as any).id));
      if (plan.target === 'records') {
        return text(`🗑️ Registro ${index} apagado.`);
      }
      // Se a mesma mensagem também apaga cofrinhos, o registro já foi removido e os
      // cofrinhos seguem para a confirmação em lote abaixo.
      void lastContext;
    } else if (plan.record_scope === 'all') {
      recordMode = 'all';
      recordCount = await countRecords(context.company.id);
    } else if (plan.record_scope === 'shown') {
      const lastQuery = await getCashQueryContext(context.company.id, context.message.phone);
      if (lastQuery && lastQuery !== HISTORY_CONTEXT && plan.target === 'records') {
        // Reaproveita o mecanismo seguro existente que resolve exatamente a última
        // consulta exibida e pede confirmação antes de apagar.
        return await handleCashBulkDeletionCommand({
          ...context,
          combinedText: 'apague todos esses registros'
        });
      }
      recordIds = await historyIds(context, 5);
      recordMode = 'ids';
      recordCount = recordIds.length;
      if (!recordCount) return text('Não há registros recentes para apagar.');
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
        return text(`Não encontrei: ${resolved.missing.join(', ')}. Mande *meus cofrinhos* para conferir os nomes.`);
      }
      pocketIds = resolved.selected.map(item => String(item.id));
      pocketNames = resolved.selected.map(item => item.name);
    }

    if (!pocketIds.length && plan.target === 'pockets') {
      return text('Não encontrei nenhum cofrinho para apagar.');
    }
  }

  // Um único cofrinho, sem outra exclusão em lote, mantém o comportamento simples.
  if (plan.target === 'pockets' && pocketIds.length === 1) {
    const done = await executePending(context, {
      recordMode: null,
      recordIds: [],
      recordCount: 0,
      pocketIds,
      pocketNames
    });
    return text(done.pockets === 1 ? `🐷 Cofrinho *${pocketNames[0]}* apagado.` : 'Esse cofrinho já não estava ativo.');
  }

  if (recordMode === 'all' && recordCount === 0 && !pocketIds.length) {
    return text('Você não tem registros para apagar.');
  }

  const pending: PendingNaturalDeletion = {
    recordMode,
    recordIds,
    recordCount,
    pocketIds,
    pocketNames
  };

  if (!recordMode && !pocketIds.length) {
    return plan.clarification?.trim() ? text(plan.clarification.trim()) : text('Não consegui identificar com segurança o que você quer apagar.');
  }

  await savePending(context, pending);
  return confirmationPrompt(pending);
}

function isConfirmation(value: string): boolean {
  return /^(sim|confirmo|pode|pode apagar|apaga|isso mesmo|correto)$/i.test(String(value ?? '').trim().replace(/[!.]+$/g, ''));
}

function isCancellation(value: string): boolean {
  return /^(não|nao|n|cancela|cancelar|deixa pra lá|deixa pra la|não apaga|nao apaga)$/i.test(String(value ?? '').trim().replace(/[!.]+$/g, ''));
}

export async function handleCashPendingAiDeletion(context: VerticalContext): Promise<VerticalResult | undefined> {
  const pending = await loadPending(context);
  if (!pending) return undefined;

  if (isCancellation(context.combinedText)) {
    await clearPending(context);
    return text('Tudo bem 👍 Não apaguei nada.');
  }

  if (!isConfirmation(context.combinedText)) {
    // Uma nova intenção explícita sempre vence uma confirmação antiga. O estado é
    // descartado para não sequestrar a próxima mensagem nem um “sim” futuro.
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
