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
  'menu',
  'register',
  'query',
  'pockets',
  'forecasts',
  'manage',
  'reports',
  'plans'
]);

const SemanticSchema = z.object({
  intent: z.enum([
    'transaction',
    'mixed',
    'query',
    'balance',
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
    'help',
    'plans',
    'trial',
    'categories',
    'schedule',
    'confirmation',
    'cancellation',
    'acknowledgement',
    'unknown'
  ]),
  social_kind: z.enum(['greeting', 'thanks', 'farewell', 'wellbeing', 'ack', 'none']),
  help_section: HelpSectionSchema.nullable(),
  rewritten_text: z.string().nullable(),
  clarification: z.string().nullable()
});

type SemanticIntent = z.infer<typeof SemanticSchema>;
type SemanticRouteResult = {
  parsed: SemanticIntent;
  estimatedUsd: number;
};

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

// Mantido somente como API de compatibilidade de testes antigos. Não participa do
// caminho de decisão em produção; toda interpretação conversacional passa pela IA.
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
  const memory = await loadCashConversationMemory(
    context.company.id,
    context.message.phone,
    cashConversationMemorySize
  );

  const hasCurrentMessage = Boolean(
    context.message.messageId
      ? memory.some(entry => entry.role === 'user' && entry.messageId === context.message.messageId)
      : memory.at(-1)?.role === 'user' && memory.at(-1)?.text === context.combinedText.trim()
  );

  const conversationInput: Array<{ role: 'user' | 'assistant'; content: string }> = memory.map(entry => ({
    role: entry.role,
    content: entry.text
  }));
  if (!hasCurrentMessage) conversationInput.push({ role: 'user', content: context.combinedText });

  try {
    const response = await client.responses.parse({
      model: env.cashOpenaiModel,
      reasoning: { effort: 'minimal' },
      max_output_tokens: 320,
      input: [
        {
          role: 'system',
          content: [
            'Você é o cérebro conversacional do Arles Cash, um assistente financeiro pelo WhatsApp.',
            'Fale e interprete português brasileiro natural, inclusive abreviações, erros, gírias e frases incompletas.',
            `Você recebe no máximo ${cashConversationMemorySize} mensagens recentes. A última mensagem user é sempre o pedido atual; as anteriores servem apenas como contexto.`,
            'Você é a ÚNICA camada que decide a intenção da linguagem do usuário. Não dependa de palavras-chave, regex ou regras textuais externas.',
            'Use o histórico para resolver referências como “isso”, “o 2”, “esses”, “de hoje”, “aquele cofrinho” e respostas curtas de confirmação.',
            'Se a última resposta do assistant pediu confirmação explícita de uma ação e o usuário concordar, use confirmation. Se recusar/cancelar, use cancellation.',
            'Fora de uma confirmação pendente, “sim”, “ok”, “certo” e equivalentes normalmente são acknowledgement.',
            'Nunca invente valores, datas, nomes, registros ou saldos. Preserve exatamente os dados informados pelo usuário.',
            'Você não faz contas e não calcula saldo, soma, média, porcentagem, diferença ou projeção. Marque a intenção correta e deixe o backend executar matemática por script/SQL.',
            'Em rewritten_text, torne o pedido explícito e curto, preservando todos os valores, datas, nomes, índices, filtros, cofrinhos e recorrências necessários ao executor.',
            'Se houver duas ações diferentes na mesma mensagem, use mixed e reescreva cada objetivo em uma linha.',
            'Use unknown somente quando o contexto realmente não permitir entender com segurança; clarification deve ser uma pergunta curta, educada e objetiva.',
            '',
            'INTENÇÕES DISPONÍVEIS:',
            'transaction = registrar dinheiro real que já entrou ou saiu.',
            'query = consultar/listar/somar lançamentos existentes com filtros ou período.',
            'balance = saldo/posição financeira atual ou acumulada.',
            'projection = simulação hipotética sem registrar nada.',
            'pocket = criar, consultar, organizar ou mover valores em cofrinhos.',
            'forecast_schedule = criar previsão/agendamento futuro ou recorrente.',
            'forecast_query = consultar previsões/agendamentos.',
            'history = mostrar registros recentes numerados.',
            'weekly_report/monthly_report = relatório da semana/mês.',
            'edit = alterar um registro existente.',
            'delete = excluir registro(s) ou cofrinho(s).',
            'undo = restaurar/desfazer uma exclusão quando o usuário pedir isso explicitamente.',
            'help = explicar como usar o Cash; escolha help_section.',
            'plans/trial/categories/schedule = funções administrativas do produto.',
            'confirmation/cancellation = responder a uma confirmação pendente.',
            'acknowledgement = saudação, agradecimento, despedida ou conversa curta sem ação financeira.',
            'unknown = intenção realmente ambígua.',
            '',
            'ESTILO: seja educado, natural e econômico. Quando precisar produzir uma clarification, prefira uma frase curta.',
            quoted ? `A mensagem atual cita/responde a: ${quoted}` : 'A mensagem atual não cita outra mensagem.'
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
        `[CashAI] stage=contextual_intent model=${env.cashOpenaiModel}` +
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

function canonical(intent: SemanticIntent['intent']): string | null {
  const map: Partial<Record<SemanticIntent['intent'], string>> = {
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

async function executePocketCanonical(context: VerticalContext, rewritten: string): Promise<VerticalResult | null> {
  const canonicalContext = { ...context, combinedText: rewritten };

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

export class CashAiFirstHandler implements VerticalHandler {
  async handle(context: VerticalContext): Promise<VerticalResult | null> {
    const semantic = await semanticRoute(context);
    if (!semantic) {
      return text('Não consegui interpretar sua mensagem agora. Tente novamente em instantes, por favor.');
    }
    const understood = semantic.parsed;

    if (understood.intent === 'confirmation' || understood.intent === 'cancellation') {
      const pending = await executeCashPendingSemanticDecision(
        context,
        understood.intent === 'confirmation' ? 'confirm' : 'cancel'
      );
      if (pending) return pending;
      return text(understood.intent === 'confirmation' ? 'Certo 👍' : 'Tudo bem 👍');
    }

    if (understood.intent === 'unknown') {
      return text(understood.clarification?.trim() || 'Pode me explicar em uma frase curta o que você quer fazer?');
    }

    if (understood.intent === 'transaction') {
      return await executeCashAiTransaction(
        context,
        understood.rewritten_text,
        semantic.estimatedUsd
      ) ?? text('Faltou alguma informação para registrar. Pode me dizer o valor e o que aconteceu?');
    }

    if (understood.intent === 'acknowledgement') {
      return text(cashSocialReply(understood.social_kind));
    }

    if (understood.intent === 'help') {
      return text(cashHelpMessage((understood.help_section ?? 'menu') as CashHelpSection));
    }

    if (understood.intent === 'history') {
      await rememberCashQueryContext(context.company.id, context.message.phone, cashHistoryContextMarker);
      return await cashConversationHandler.handle({ ...context, combinedText: 'histórico' });
    }

    // A IA decide o que precisa ser calculado; matemática e agregações continuam
    // executadas por código/SQL, nunca pelo modelo.
    if (understood.intent === 'balance') {
      return await handleCashLedgerDeterministic({ ...context, combinedText: 'saldo' });
    }

    if (understood.intent === 'projection') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      const result = await handleCashLedgerDeterministic({ ...context, combinedText: rewritten });
      return result ?? text('Não consegui calcular a simulação com os dados informados.');
    }

    if (understood.intent === 'delete') {
      if (context.message.quotedMessageId || context.message.quotedText) {
        const quoted = await handleCashQuotedManagement({
          ...context,
          combinedText: understood.rewritten_text?.trim() || context.combinedText
        });
        if (quoted) return quoted;
      }
      return await executeCashAiDeletion(
        context,
        understood.rewritten_text,
        semantic.estimatedUsd
      );
    }

    if (understood.intent === 'pocket') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      const result = await executePocketCanonical(context, rewritten);
      return result ?? text('Diga qual cofrinho e o que você quer fazer com ele.');
    }

    if (understood.intent === 'forecast_schedule' || understood.intent === 'forecast_query') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      const result = await handleCashScheduleDeterministic({ ...context, combinedText: rewritten });
      return result ?? text('Informe o valor e a data ou recorrência da previsão.');
    }

    if (understood.intent === 'mixed') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      const result = await handleCashMixedNarrativeGate({ ...context, combinedText: rewritten });
      return result ?? text('Pode separar esse pedido em duas frases para eu concluir certinho?');
    }

    if (understood.intent === 'edit') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      if (context.message.quotedMessageId || context.message.quotedText) {
        const quoted = await handleCashQuotedManagement({ ...context, combinedText: rewritten });
        if (quoted) return quoted;
      }
      const result = await cashBroadHandler.handle({ ...context, combinedText: rewritten });
      return result ?? text('Não consegui localizar o lançamento que você quer alterar.');
    }

    if (understood.intent === 'query') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      const result = await cashBroadHandler.handle({ ...context, combinedText: rewritten });
      return result ?? text('Não encontrei dados para essa consulta.');
    }

    const command = canonical(understood.intent);
    if (command) {
      const result = await cashBroadHandler.handle({ ...context, combinedText: command });
      return result ?? text('Não consegui concluir essa ação agora.');
    }

    return text('Não consegui concluir esse pedido agora. Pode tentar de outra forma?');
  }
}

export const cashAiFirstHandler = new CashAiFirstHandler();
