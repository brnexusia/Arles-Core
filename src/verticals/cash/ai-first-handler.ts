import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { VerticalContext, VerticalHandler, VerticalResult } from '../vertical.js';
import { executeCashAiDeletion, handleCashPendingAiDeletion, cashHistoryContextMarker } from './ai-deletion-executor.js';
import { executeCashAiTransaction } from './ai-transaction-executor.js';
import { cashBroadHandler } from './broad-handler.js';
import { handleCashPocketCommand } from './cofrinhos.js';
import {
  cashConversationMemorySize,
  loadCashConversationMemory
} from './conversation-memory.js';
import { cashConversationHandler } from './conversation.js';
import { rememberCashQueryContext } from './conversation-state.js';
import {
  executeCashContextualCalculation,
  type CashContextualCalculationSpec
} from './contextual-calculation.js';
import { handleCashPendingDeletion } from './deletion.js';
import { cashHandler } from './handler.js';
import { cashHelpMessage, type CashHelpSection } from './help.js';
import { cashLedgerService, handleCashLedgerDeterministic } from './ledger.js';
import { editTarget } from './management.js';
import { handleCashMixedNarrativeGate } from './mixed-narrative-gate.js';
import { handleCashPendingEditInteraction } from './pending-edit-interaction.js';
import { handleCashPocketClosingFlow, handleCashPendingPocketClosing } from './pocket-closing-flow.js';
import { handleCashPocketContextCommand } from './pocket-context.js';
import { handleCashPocketOrganization } from './pocket-organization.js';
import { handleCashPocketReceivable } from './pocket-receivables.js';
import { handleCashPocketTransfer, handleCashPendingPocketTransfer } from './pocket-transfer.js';
import { cashQuery } from './query.js';
import { handleCashScheduleDeterministic } from './schedules.js';
import { cashService } from './service.js';

// Esta constante é deliberadamente fixa. CASH_OPENAI_MODEL não pode trocar o modelo
// que decide a intenção: toda mensagem do Cash passa primeiro pelo GPT-5 Nano.
export const CASH_FIRST_INTERPRETER_MODEL = 'gpt-5-nano' as const;

const HelpSectionSchema = z.enum([
  'menu',
  'register',
  'query',
  'pockets',
  'forecasts',
  'manage',
  'reports',
  'plans'
]);

const CalculationBaseSchema = z.object({
  kind: z.enum(['literal', 'transaction', 'global_balance', 'available_balance']),
  transaction_id: z.string().nullable(),
  amount: z.number().nullable()
});

const CalculationOperationSchema = z.object({
  operator: z.enum(['add', 'subtract']),
  source: z.enum(['literal', 'transaction']),
  transaction_id: z.string().nullable(),
  amount: z.number().nullable()
});

const CalculationSchema = z.object({
  base: CalculationBaseSchema,
  operations: z.array(CalculationOperationSchema).max(20)
});

const SemanticSchema = z.object({
  intent: z.enum([
    'onboarding_name',
    'onboarding_email',
    'transaction',
    'mixed',
    'query',
    'balance',
    'calculation',
    'projection',
    'pocket',
    'forecast_schedule',
    'forecast_query',
    'history',
    'weekly_report',
    'monthly_report',
    'edit',
    'delete',
    'undo',
    'pending_confirm',
    'pending_cancel',
    'help',
    'plans',
    'trial',
    'categories',
    'schedule',
    'acknowledgement',
    'unknown'
  ]),
  social_kind: z.enum(['greeting', 'thanks', 'farewell', 'wellbeing', 'ack', 'none']),
  help_section: HelpSectionSchema.nullable(),
  rewritten_text: z.string().nullable(),
  clarification: z.string().nullable(),
  calculation: CalculationSchema.nullable()
});

export type CashSemanticIntent = z.infer<typeof SemanticSchema>;
export type CashSemanticRouteResult = {
  parsed: CashSemanticIntent;
  estimatedUsd: number;
};

export interface CashInterpretationState {
  onboardingState?: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
}

const client = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;

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

// Compatibilidade exclusiva com testes/parsers legados. Esta função NÃO é chamada
// pelo pipeline de roteamento e nunca pode decidir a intenção de uma mensagem real.
export function isCashNaturalRecordListRequest(input: string): boolean {
  const value = normalize(input).replace(/[!?.,]+$/g, '').trim();
  if (!value || /\b(como|ajuda|ensina|explica)\b/.test(value)) return false;

  return /^(?:(?:me )?(?:fala|mostra|mostre|lista|liste|traz|traga|diz|fale)\s+)?(?:(?:ai|aí)\s+)?(?:os\s+)?(?:meus\s+)?(?:registros|registos|lancamentos|movimentacoes)(?:\s+(?:ai|aí|pra mim|para mim))?$/.test(value)
    || /^(?:quais|qual)\s+(?:sao\s+)?(?:os\s+)?(?:meus\s+)?(?:registros|registos|lancamentos|movimentacoes)$/.test(value);
}

export function cashSocialReply(kind: CashSemanticIntent['social_kind'] | null | undefined): string {
  if (kind === 'greeting') return 'Oi! 😊 Como posso te ajudar?';
  if (kind === 'thanks') return 'Por nada! 😊';
  if (kind === 'farewell') return 'Até mais! 👋';
  if (kind === 'wellbeing') return 'Tudo certo por aqui 😊 E com você?';
  return 'Certo 👍';
}

function estimatedNanoCostUsd(response: unknown): number {
  const usage = (response as any)?.usage;
  const input = Number(usage?.input_tokens ?? 0);
  const output = Number(usage?.output_tokens ?? 0);
  return (input * 0.05 + output * 0.40) / 1_000_000;
}

function moneyForPrompt(value: unknown): string {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toFixed(2) : '0.00';
}

async function financialStateForPrompt(context: VerticalContext): Promise<string> {
  const [rows, snapshot, availability] = await Promise.all([
    cashService.listTransactions(context.company.id, { limit: 30 }).catch(() => []),
    cashLedgerService.snapshot(context.company.id).catch(() => null),
    cashLedgerService.availability(context.company.id).catch(() => null)
  ]);

  const lines = [
    'ESTADO FINANCEIRO VALIDADO PELO BACKEND (somente contexto; não faça a matemática):',
    snapshot
      ? `saldo_global=${moneyForPrompt(snapshot.balance)} entradas=${moneyForPrompt(snapshot.income)} saidas=${moneyForPrompt(snapshot.expense)} registros=${snapshot.count}`
      : 'saldo_global=indisponivel',
    availability
      ? `saldo_disponivel_fora_cofrinhos=${moneyForPrompt(availability.available)} total_em_cofrinhos=${moneyForPrompt(availability.pockets)}`
      : 'saldo_disponivel_fora_cofrinhos=indisponivel',
    'LANÇAMENTOS RECENTES (use o id quando uma referência apontar para um lançamento):'
  ];

  if (!rows.length) lines.push('(nenhum lançamento recente disponível)');
  for (const row of rows) {
    const description = String(row.description ?? row.merchant ?? row.category ?? '').replace(/\s+/g, ' ').slice(0, 120);
    lines.push(
      `id=${String(row.id)} type=${String(row.type)} amount=${moneyForPrompt(row.amount)}` +
      ` date=${String(row.transaction_date).slice(0, 10)} category=${String(row.category ?? '')}` +
      ` description=${description || '-'}`
    );
  }
  return lines.join('\n');
}

function onboardingPrompt(state: CashInterpretationState): string {
  const onboardingState = state.onboardingState ?? 'active';
  return [
    'ESTADO DE ONBOARDING VALIDADO PELO BACKEND:',
    `onboarding_state=${onboardingState}`,
    `owner_name=${state.ownerName ?? '-'}`,
    `owner_email=${state.ownerEmail ?? '-'}`,
    'Se onboarding_state for welcome/awaiting_name e a mensagem atual fornecer o nome da própria pessoa, use onboarding_name e rewritten_text SOMENTE com o nome.',
    'Se onboarding_state for awaiting_email e a mensagem atual fornecer o e-mail da própria pessoa, use onboarding_email e rewritten_text SOMENTE com o e-mail.',
    'Não invente nome ou e-mail. Se o dado obrigatório não estiver presente, classifique a intenção real da mensagem; o backend continuará o onboarding sem executar ação financeira.'
  ].join('\n');
}

export function cashAiInterpretationFailure(): VerticalResult {
  return text('Tive uma falha ao interpretar sua mensagem agora. Nenhuma ação financeira foi executada. Pode repetir a mesma frase?');
}

async function semanticRoute(
  context: VerticalContext,
  state: CashInterpretationState = {}
): Promise<CashSemanticRouteResult | null> {
  if (!client) return null;

  const quoted = String(context.message.quotedText ?? '').trim();
  const [memory, financialState] = await Promise.all([
    loadCashConversationMemory(
      context.company.id,
      context.message.phone,
      cashConversationMemorySize
    ),
    financialStateForPrompt(context)
  ]);

  const hasCurrentMessage = Boolean(
    context.message.messageId
      ? memory.some(entry => entry.role === 'user' && entry.messageId === context.message.messageId)
      : memory.at(-1)?.role === 'user' && memory.at(-1)?.text === context.combinedText.trim()
  );

  const conversationInput: Array<{ role: 'user' | 'assistant'; content: string }> = memory.map(entry => ({
    role: entry.role,
    content: entry.text
  }));
  if (!hasCurrentMessage) {
    conversationInput.push({ role: 'user', content: context.combinedText });
  }

  try {
    const response = await client.responses.parse({
      model: CASH_FIRST_INTERPRETER_MODEL,
      reasoning: { effort: 'minimal' },
      max_output_tokens: 700,
      input: [
        {
          role: 'system',
          content: [
            'Você é a PRIMEIRA e ÚNICA camada que decide a intenção da mensagem no Arles Cash.',
            'Nenhuma regex, palavra-chave ou if/else decide a intenção antes de você. O backend depois apenas valida parâmetros e executa a intenção que você escolheu.',
            `Você recebe até ${cashConversationMemorySize} mensagens recentes da conversa real, estado de onboarding e estado financeiro validado pelo backend.`,
            'A ÚLTIMA mensagem com role=user é o pedido atual. Classifique SOMENTE essa mensagem, usando as anteriores para resolver referências.',
            'Mensagens anteriores do assistant são contexto e podem conter sugestões. Nunca transforme uma sugestão anterior do assistant em pedido atual do usuário.',
            'Entenda português brasileiro natural, erros, gírias, frases incompletas e referências como “isso”, “aquilo”, “dos X”, “o que eu paguei”, “essas despesas”, “quanto sobrou”, “desfaz o último”, “quanto ficou depois daquilo”.',
            'Você NÃO grava, NÃO apaga, NÃO altera saldo e NÃO calcula o resultado de contas. Você escolhe intenção e parâmetros/referências; o backend valida e calcula.',
            'Use IDs do catálogo financeiro quando uma referência apontar para lançamentos existentes. Nunca invente ID.',
            'Se uma referência puder apontar para mais de um lançamento e o histórico não resolver com segurança, use unknown e faça uma pergunta específica em clarification.',
            '',
            'INTENÇÕES:',
            'onboarding_name/onboarding_email: dados exigidos pelo onboarding, conforme estado informado.',
            'transaction: dinheiro REAL que já entrou/saiu e deve virar lançamento.',
            'mixed: a mensagem atual pede duas ou mais ações diferentes. Reescreva todas, uma por linha.',
            'query: consultar/listar/somar registros já salvos por período, descrição, categoria, pessoa ou filtro.',
            'balance: saldo financeiro global/atual, sem uma base contextual específica.',
            'calculation: conta factual baseada em um valor específico, lançamento(s) ou referência contextual já ocorrida. Exemplos gerais: “quanto restou daquela entrada depois desses pagamentos?”, “quanto ficou depois daquilo?”, “pega aquele recebimento e desconta o que paguei”. NÃO transforme isso em balance global.',
            'projection: simulação hipotética/futura, sem gravar nada.',
            'pocket: criar/listar/consultar/mover dinheiro em cofrinho. Exclusão de cofrinho é delete.',
            'forecast_schedule: criar previsão/agendamento futuro ou recorrente.',
            'forecast_query: consultar previsões/saldo projetado.',
            'history: mostrar últimos registros numerados.',
            'weekly_report/monthly_report: relatórios reais.',
            'edit: corrigir lançamento existente ou continuar uma edição pendente.',
            'delete: excluir lançamento(s), histórico selecionado ou cofrinho(s).',
            'undo: restaurar/desfazer uma exclusão já concluída, inclusive “desfaz o último” quando o contexto mostra exclusão anterior.',
            'pending_confirm: confirmação curta de uma ação pendente mostrada pelo assistant, como “sim”, “isso”, “pode fazer”.',
            'pending_cancel: cancelamento de uma ação pendente mostrada pelo assistant.',
            'help/plans/trial/categories/schedule: funções administrativas e ajuda.',
            'acknowledgement: conversa social sem ação financeira.',
            'unknown: falta informação real ou a referência é ambígua mesmo com contexto.',
            '',
            'CÁLCULO CONTEXTUAL:',
            'Quando intent=calculation, preencha calculation. base.kind=transaction para usar um lançamento do catálogo, literal para um valor explícito que não é lançamento, global_balance para o saldo global e available_balance para saldo fora dos cofrinhos.',
            'Cada operação é add/subtract e usa source=transaction com transaction_id validado ou source=literal com amount explícito.',
            'Nunca coloque o resultado final em amount. Nunca faça a soma/subtração você mesmo.',
            'Se a pessoa pergunta quanto sobrou DE uma entrada específica após despesas específicas, a base é essa entrada, e as despesas são operações subtract. Não use saldo global.',
            '',
            'REGRAS DE SAÍDA:',
            'Para transaction, rewritten_text preserva valor, natureza (entrada/saída), descrição e data factual.',
            'Para query/edit/delete/pocket/forecast/mixed/projection, rewritten_text torna o referente explícito sem mudar a intenção.',
            'Para acknowledgement, social_kind identifica greeting/thanks/farewell/wellbeing/ack; nos demais use none.',
            'Para help, help_section deve ser menu/register/query/pockets/forecasts/manage/reports/plans; nos demais use null.',
            'calculation deve ser null quando intent não for calculation.',
            'clarification só é preenchida quando intent=unknown.',
            'CRÍTICO: matemática, saldo, persistência, exclusão e edição são validados/executados pelo backend depois desta decisão.',
            '',
            onboardingPrompt(state),
            '',
            financialState,
            '',
            quoted ? `A mensagem atual responde/cita este conteúdo: ${quoted}` : 'A mensagem atual não cita outra mensagem.'
          ].join('\n')
        },
        ...conversationInput
      ],
      text: { format: zodTextFormat(SemanticSchema, 'cash_semantic_intent') }
    });

    const parsed = response.output_parsed;
    if (!parsed) return null;

    const estimatedUsd = estimatedNanoCostUsd(response);
    const usage = (response as any).usage;
    if (usage) {
      console.info(
        `[CashAI] stage=first_intent model=${CASH_FIRST_INTERPRETER_MODEL}` +
        ` memory_messages=${conversationInput.length}` +
        ` message=${context.message.messageId || 'unknown'}` +
        ` input_tokens=${usage.input_tokens ?? 0}` +
        ` output_tokens=${usage.output_tokens ?? 0}` +
        ` estimated_usd=${estimatedUsd.toFixed(8)}`
      );
    }

    return { parsed, estimatedUsd };
  } catch (error) {
    console.error('[CashAI] falha na camada semântica contextual:', error);
    return null;
  }
}

function canonical(intent: CashSemanticIntent['intent']): string | null {
  const map: Partial<Record<CashSemanticIntent['intent'], string>> = {
    weekly_report: 'relatório semanal',
    monthly_report: 'relatório mensal',
    undo: 'coloca o último registro excluído de volta',
    plans: 'planos',
    trial: 'trial',
    categories: 'categorias',
    schedule: 'quando recebo os relatórios?'
  };
  return map[intent] ?? null;
}

function canonicalExecutionContext(context: VerticalContext, combinedText: string): VerticalContext {
  return {
    ...context,
    combinedText,
    message: {
      ...context.message,
      quotedText: undefined,
      quotedMessageId: undefined
    }
  };
}

async function executePocketCanonical(context: VerticalContext, rewritten: string): Promise<VerticalResult | null> {
  const canonicalContext = canonicalExecutionContext(context, rewritten);

  const direct = await handleCashPocketCommand(canonicalContext);
  if (direct) return direct;

  const closing = await handleCashPocketClosingFlow(canonicalContext);
  if (closing) return closing;

  const receivable = await handleCashPocketReceivable(canonicalContext);
  if (receivable) return receivable;

  const transfer = await handleCashPocketTransfer(canonicalContext);
  if (transfer) return transfer;

  const organization = await handleCashPocketOrganization(canonicalContext);
  if (organization) return organization;

  return await handleCashPocketContextCommand(canonicalContext);
}

async function executePending(context: VerticalContext): Promise<VerticalResult | null> {
  // A intenção pending_confirm/pending_cancel já foi decidida pelo Nano. Estes handlers
  // apenas consultam o estado pendente e aplicam/cancelam a operação correspondente.
  return (await handleCashPendingAiDeletion(context))
    ?? (await handleCashPendingPocketClosing(context))
    ?? (await handleCashPendingPocketTransfer(context))
    ?? (await handleCashPendingDeletion(context))
    ?? (await handleCashPendingEditInteraction(context))
    ?? null;
}

export class CashAiFirstHandler implements VerticalHandler {
  async interpret(
    context: VerticalContext,
    state: CashInterpretationState = {}
  ): Promise<CashSemanticRouteResult | null> {
    return await semanticRoute(context, state);
  }

  async execute(
    context: VerticalContext,
    semantic: CashSemanticRouteResult
  ): Promise<VerticalResult | null> {
    const understood = semantic.parsed;

    if (understood.intent === 'onboarding_name' || understood.intent === 'onboarding_email') {
      return null;
    }

    if (understood.intent === 'unknown') {
      return text(understood.clarification?.trim() || 'Não consegui identificar exatamente o que você quer fazer. Pode me explicar um pouco mais?');
    }

    if (understood.intent === 'transaction') {
      // Não existe veto regex aqui. A IA já decidiu a intenção; a segunda camada Nano
      // extrai os campos e o backend valida cada valor antes de persistir.
      return await executeCashAiTransaction(
        context,
        understood.rewritten_text,
        semantic.estimatedUsd
      );
    }

    if (understood.intent === 'calculation') {
      return await executeCashContextualCalculation(
        context,
        understood.calculation as CashContextualCalculationSpec | null
      );
    }

    if (understood.intent === 'acknowledgement') {
      return text(cashSocialReply(understood.social_kind));
    }

    if (understood.intent === 'help') {
      return text(cashHelpMessage((understood.help_section ?? 'menu') as CashHelpSection));
    }

    if (understood.intent === 'pending_confirm' || understood.intent === 'pending_cancel') {
      const pending = await executePending(context);
      return pending ?? text('Não encontrei uma ação pendente para confirmar ou cancelar. Me diga o que você quer fazer.');
    }

    if (understood.intent === 'history') {
      await rememberCashQueryContext(context.company.id, context.message.phone, cashHistoryContextMarker);
      return await cashHandler.handle(canonicalExecutionContext(context, 'histórico'));
    }

    if (understood.intent === 'balance') {
      return await handleCashLedgerDeterministic(canonicalExecutionContext(context, 'saldo'));
    }

    if (understood.intent === 'projection') {
      const rewritten = understood.rewritten_text?.trim();
      if (!rewritten) return text('Entendi a simulação, mas faltou dizer quais valores devo usar.');
      const result = await handleCashLedgerDeterministic(canonicalExecutionContext(context, rewritten));
      return result ?? text('Entendi a simulação, mas não consegui validar os valores necessários.');
    }

    if (understood.intent === 'delete') {
      return await executeCashAiDeletion(
        context,
        understood.rewritten_text,
        semantic.estimatedUsd
      );
    }

    if (understood.intent === 'pocket') {
      const rewritten = understood.rewritten_text?.trim();
      if (!rewritten) return text('Entendi a ação de cofrinho, mas faltou identificar qual cofrinho ou operação.');
      const result = await executePocketCanonical(context, rewritten);
      return result ?? text('Entendi a ação de cofrinho, mas algum dado necessário não pôde ser validado.');
    }

    if (understood.intent === 'forecast_schedule' || understood.intent === 'forecast_query') {
      const rewritten = understood.rewritten_text?.trim();
      if (!rewritten) return text('Entendi a previsão/agendamento, mas faltou valor, data ou recorrência.');
      const result = await handleCashScheduleDeterministic(canonicalExecutionContext(context, rewritten));
      return result ?? text('Entendi a previsão/agendamento, mas não consegui validar os dados necessários.');
    }

    if (understood.intent === 'mixed') {
      const rewritten = understood.rewritten_text?.trim();
      if (!rewritten) return text('Entendi que há mais de uma ação, mas não consegui separar os dados com segurança.');
      const result = await handleCashMixedNarrativeGate(canonicalExecutionContext(context, rewritten));
      return result ?? text('Entendi que há mais de uma ação, mas alguma delas ficou sem dados suficientes.');
    }

    if (understood.intent === 'query') {
      const rewritten = understood.rewritten_text?.trim();
      if (!rewritten) return text('Entendi a consulta, mas faltou identificar o que você quer consultar.');
      const result = await cashQuery.handle(context.company.id, rewritten);
      return result ?? text('Entendi a consulta, mas não consegui validar os filtros necessários. Pode especificar período ou lançamento?');
    }

    if (understood.intent === 'edit') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      const pending = await handleCashPendingEditInteraction(canonicalExecutionContext(context, rewritten));
      if (pending) return pending;
      if (!editTarget(rewritten)) {
        return text('Entendi que você quer corrigir um lançamento, mas não consegui identificar qual registro deve ser alterado.');
      }
      return await cashHandler.handle(canonicalExecutionContext(context, rewritten));
    }

    if (understood.intent === 'undo') {
      return await cashConversationHandler.handle(canonicalExecutionContext(context, canonical('undo')!));
    }

    const command = canonical(understood.intent);
    if (command) {
      // Contexto canônico sem quote impede handlers legados de reinterpretarem uma
      // referência antiga. Eles recebem uma rota já decidida pelo Nano e só executam.
      const result = await cashBroadHandler.handle(canonicalExecutionContext(context, command));
      return result ?? text('Entendi o pedido, mas não consegui concluir essa ação agora.');
    }

    return text('Entendi sua mensagem, mas não consegui concluir a ação com segurança.');
  }

  async handle(context: VerticalContext): Promise<VerticalResult | null> {
    const semantic = await this.interpret(context);
    if (!semantic) return cashAiInterpretationFailure();
    return await this.execute(context, semantic);
  }
}

export const cashAiFirstHandler = new CashAiFirstHandler();
