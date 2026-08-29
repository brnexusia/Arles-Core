import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { VerticalContext, VerticalHandler, VerticalResult } from '../vertical.js';
import { executeCashAiDeletion, cashHistoryContextMarker } from './ai-deletion-executor.js';
import { cashBroadHandler } from './broad-handler.js';
import { handleCashPocketCommand } from './cofrinhos.js';
import { cashConversationHandler } from './conversation.js';
import {
  cashConversationMemorySize,
  loadCashConversationMemory
} from './conversation-memory.js';
import { rememberCashQueryContext } from './conversation-state.js';
import { cashHelpMessage, type CashHelpSection } from './help.js';
import { handleCashLedgerDeterministic } from './ledger.js';
import { handleCashMixedNarrativeGate } from './mixed-narrative-gate.js';
import { executeCashPendingSemanticDecision } from './pending-semantic-executor.js';
import { handleCashPocketClosingFlow } from './pocket-closing-flow.js';
import { handleCashPocketContextCommand } from './pocket-context.js';
import { handleCashPocketOrganization } from './pocket-organization.js';
import { handleCashPocketReceivable } from './pocket-receivables.js';
import { handleCashPocketTransfer } from './pocket-transfer.js';
import { handleCashQuotedManagement } from './quoted-management.js';
import { handleCashScheduleDeterministic } from './schedules.js';
import { executeCashAiTransaction } from './ai-transaction-executor.js';

const HelpSectionSchema = z.enum([
  'menu', 'register', 'query', 'pockets', 'forecasts', 'manage', 'reports', 'plans'
]);

const CalculationSchema = z.object({
  base_mode: z.enum(['zero', 'current_balance', 'explicit']),
  explicit_base: z.number().finite().nullable(),
  operations: z.array(z.object({
    type: z.enum(['income', 'expense']),
    amount: z.number().positive()
  })).min(1).max(30)
});

const SemanticSchema = z.object({
  intent: z.enum([
    'transaction', 'mixed', 'query', 'balance', 'calculation', 'projection', 'pocket',
    'forecast_schedule', 'forecast_query', 'history', 'weekly_report', 'monthly_report',
    'edit', 'delete', 'undo', 'help', 'plans', 'trial', 'categories', 'schedule',
    'confirmation', 'cancellation', 'acknowledgement', 'unknown'
  ]),
  social_kind: z.enum(['greeting', 'thanks', 'farewell', 'wellbeing', 'ack', 'none']),
  help_section: HelpSectionSchema.nullable(),
  rewritten_text: z.string().nullable(),
  clarification: z.string().nullable(),
  calculation: CalculationSchema.nullable()
});

type SemanticIntent = z.infer<typeof SemanticSchema>;
type SemanticRouteResult = { parsed: SemanticIntent; estimatedUsd: number };

const client = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function normalize(value: string): string {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Compatibilidade de testes legados. Não participa da decisão de intenção em produção.
export function isCashNaturalRecordListRequest(input: string): boolean {
  const value = normalize(input).replace(/[!?.,]+$/g, '').trim();
  if (!value || /\b(como|ajuda|ensina|explica)\b/.test(value)) return false;
  return /^(?:(?:me )?(?:fala|mostra|mostre|lista|liste|traz|traga|diz|fale)\s+)?(?:(?:ai|aí)\s+)?(?:os\s+)?(?:meus\s+)?(?:registros|registos|lancamentos|movimentacoes)(?:\s+(?:ai|aí|pra mim|para mim))?$/.test(value)
    || /^(?:quais|qual)\s+(?:sao\s+)?(?:os\s+)?(?:meus\s+)?(?:registros|registos|lancamentos|movimentacoes)$/.test(value);
}

export function cashSocialReply(kind: SemanticIntent['social_kind'] | null | undefined): string {
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

async function semanticRoute(context: VerticalContext): Promise<SemanticRouteResult | null> {
  if (!client) return null;
  const quoted = String(context.message.quotedText ?? '').trim();
  const memory = await loadCashConversationMemory(context.company.id, context.message.phone, cashConversationMemorySize);
  const hasCurrentMessage = Boolean(
    context.message.messageId
      ? memory.some(entry => entry.role === 'user' && entry.messageId === context.message.messageId)
      : memory.at(-1)?.role === 'user' && memory.at(-1)?.text === context.combinedText.trim()
  );
  const conversationInput: Array<{ role: 'user' | 'assistant'; content: string }> = memory.map(entry => ({ role: entry.role, content: entry.text }));
  if (!hasCurrentMessage) conversationInput.push({ role: 'user', content: context.combinedText });

  try {
    const response = await client.responses.parse({
      model: env.cashOpenaiModel,
      reasoning: { effort: 'minimal' },
      max_output_tokens: 520,
      input: [{
        role: 'system',
        content: [
          'Você é o cérebro conversacional do Arles Cash, um assistente financeiro pelo WhatsApp.',
          'Interprete português brasileiro natural, abreviações, erros, gírias e frases incompletas.',
          `Você recebe no máximo ${cashConversationMemorySize} mensagens recentes. A última mensagem user é o pedido atual; as anteriores servem como contexto.`,
          'Você é a ÚNICA camada que decide a intenção da linguagem. Não dependa de palavras-chave ou regex externas.',
          'Use o histórico para resolver referências. Nunca invente valores, datas, nomes, registros ou saldos.',
          'Você NÃO faz a conta final. Para contas contextuais, extraia operandos estruturados em calculation e deixe o backend calcular.',
          'Se houver duas ações diferentes, use mixed. Use unknown apenas quando faltar informação real.',
          '',
          'INTENÇÕES:',
          'transaction = registrar dinheiro real que já entrou ou saiu.',
          'query = consultar/listar/somar lançamentos existentes.',
          'balance = saldo/posição financeira atual.',
          'calculation = calcular quanto fica/sobra usando valores citados ou resolvidos pelo contexto, sem registrar nada.',
          'projection = simulação hipotética que não se encaixa em calculation estruturada.',
          'pocket = operações em cofrinhos.',
          'forecast_schedule = SALVAR/AGENDAR uma previsão futura ou recorrente.',
          'forecast_query = consultar previsões/agendamentos.',
          'history = mostrar registros recentes numerados.',
          'weekly_report/monthly_report = relatórios.',
          'edit/delete/undo = gestão de registros.',
          'help/plans/trial/categories/schedule = funções administrativas.',
          'confirmation/cancellation = responder a confirmação pendente.',
          'acknowledgement = conversa social sem ação financeira.',
          'unknown = intenção realmente ambígua.',
          '',
          'CONTRATO DE calculation:',
          'Use base_mode=zero quando a pessoa quer apenas a conta dos valores que listou. NÃO inclua o saldo atual implicitamente.',
          'Use base_mode=current_balance SOMENTE quando a pessoa pedir explicitamente para considerar o saldo atual/quanto tem no Cash.',
          'Use base_mode=explicit quando a pessoa fornecer um valor inicial explícito; coloque esse valor em explicit_base.',
          'Cada dinheiro que entra vira operation type=income; cada pagamento/gasto vira type=expense. Preserve os valores exatos.',
          'Exemplo obrigatório: “vou ganhar 600, pagar 120, 330 e 600, quanto vou ficar” => calculation, base_mode=zero, +600, -120, -330, -600. NÃO é forecast_schedule só porque fala do futuro.',
          'Datas e verbos no futuro, sozinhos, NÃO significam agendamento. Só use forecast_schedule quando houver pedido explícito de salvar, anotar, registrar, agendar ou programar a previsão.',
          'Quando intent não for calculation, calculation deve ser null.',
          'Em rewritten_text, preserve dados necessários aos executores legados. clarification só deve existir em unknown.',
          quoted ? `A mensagem atual cita/responde a: ${quoted}` : 'A mensagem atual não cita outra mensagem.'
        ].join('\n')
      }, ...conversationInput],
      text: { format: zodTextFormat(SemanticSchema, 'cash_semantic_intent') }
    });
    const parsed = response.output_parsed;
    if (!parsed) return null;
    const estimatedUsd = estimatedNanoCostUsd(response);
    return { parsed, estimatedUsd };
  } catch (error) {
    console.error('[CashAI] falha na camada semântica contextual:', error);
    return null;
  }
}

function canonical(intent: SemanticIntent['intent']): string | null {
  const map: Partial<Record<SemanticIntent['intent'], string>> = {
    weekly_report: 'relatório semanal', monthly_report: 'relatório mensal',
    undo: 'coloca o último registro excluído de volta', plans: 'planos', trial: 'trial',
    categories: 'categorias', schedule: 'quando recebo os relatórios?'
  };
  return map[intent] ?? null;
}

async function executePocketCanonical(context: VerticalContext, rewritten: string): Promise<VerticalResult | null> {
  const canonicalContext = { ...context, combinedText: rewritten };
  const direct = await handleCashPocketCommand(canonicalContext); if (direct) return direct;
  const closing = await handleCashPocketClosingFlow(canonicalContext); if (closing) return closing;
  const receivable = await handleCashPocketReceivable(canonicalContext); if (receivable) return receivable;
  const transfer = await handleCashPocketTransfer(canonicalContext); if (transfer) return transfer;
  const organization = await handleCashPocketOrganization(canonicalContext); if (organization) return organization;
  return await handleCashPocketContextCommand(canonicalContext);
}

export class CashAiFirstHandler implements VerticalHandler {
  async handle(context: VerticalContext): Promise<VerticalResult | null> {
    const semantic = await semanticRoute(context);
    if (!semantic) return text('Não consegui interpretar sua mensagem agora. Tente novamente em instantes, por favor.');
    const understood = semantic.parsed;

    if (understood.intent === 'confirmation' || understood.intent === 'cancellation') {
      const pending = await executeCashPendingSemanticDecision(context, understood.intent === 'confirmation' ? 'confirm' : 'cancel');
      if (pending) return pending;
      return text(understood.intent === 'confirmation' ? 'Certo 👍' : 'Tudo bem 👍');
    }
    if (understood.intent === 'unknown') return text(understood.clarification?.trim() || 'Pode me explicar em uma frase curta o que você quer fazer?');
    if (understood.intent === 'transaction') {
      return await executeCashAiTransaction(context, understood.rewritten_text, semantic.estimatedUsd)
        ?? text('Faltou alguma informação para registrar. Pode me dizer o valor e o que aconteceu?');
    }
    if (understood.intent === 'acknowledgement') return text(cashSocialReply(understood.social_kind));
    if (understood.intent === 'help') return text(cashHelpMessage((understood.help_section ?? 'menu') as CashHelpSection));
    if (understood.intent === 'history') {
      await rememberCashQueryContext(context.company.id, context.message.phone, cashHistoryContextMarker);
      return await cashConversationHandler.handle({ ...context, combinedText: 'histórico' });
    }
    if (understood.intent === 'balance') return await handleCashLedgerDeterministic({ ...context, combinedText: 'saldo' });
    if (understood.intent === 'projection') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      const result = await handleCashLedgerDeterministic({ ...context, combinedText: rewritten });
      return result ?? text('Não consegui calcular a simulação com os dados informados.');
    }
    if (understood.intent === 'calculation') {
      return text('Entendi a conta e extraí os valores. A execução matemática será habilitada na próxima camada.');
    }
    if (understood.intent === 'delete') {
      if (context.message.quotedMessageId || context.message.quotedText) {
        const quotedResult = await handleCashQuotedManagement({ ...context, combinedText: understood.rewritten_text?.trim() || context.combinedText });
        if (quotedResult) return quotedResult;
      }
      return await executeCashAiDeletion(context, understood.rewritten_text, semantic.estimatedUsd);
    }
    if (understood.intent === 'pocket') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      return await executePocketCanonical(context, rewritten) ?? text('Diga qual cofrinho e o que você quer fazer com ele.');
    }
    if (understood.intent === 'forecast_schedule' || understood.intent === 'forecast_query') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      return await handleCashScheduleDeterministic({ ...context, combinedText: rewritten }) ?? text('Informe o valor e a data ou recorrência da previsão.');
    }
    if (understood.intent === 'mixed') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      return await handleCashMixedNarrativeGate({ ...context, combinedText: rewritten }) ?? text('Pode separar esse pedido em duas frases para eu concluir certinho?');
    }
    if (understood.intent === 'edit') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      if (context.message.quotedMessageId || context.message.quotedText) {
        const quotedResult = await handleCashQuotedManagement({ ...context, combinedText: rewritten });
        if (quotedResult) return quotedResult;
      }
      return await cashBroadHandler.handle({ ...context, combinedText: rewritten }) ?? text('Não consegui localizar o lançamento que você quer alterar.');
    }
    if (understood.intent === 'query') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      return await cashBroadHandler.handle({ ...context, combinedText: rewritten }) ?? text('Não encontrei dados para essa consulta.');
    }
    const command = canonical(understood.intent);
    if (command) return await cashBroadHandler.handle({ ...context, combinedText: command }) ?? text('Não consegui concluir essa ação agora.');
    return text('Não consegui concluir esse pedido agora. Pode tentar de outra forma?');
  }
}

export const cashAiFirstHandler = new CashAiFirstHandler();
