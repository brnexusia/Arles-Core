import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { VerticalContext, VerticalHandler, VerticalResult } from '../vertical.js';
import { executeCashAiDeletion, cashHistoryContextMarker } from './ai-deletion-executor.js';
import { cashBroadHandler } from './broad-handler.js';
import { handleCashPocketCommand } from './cofrinhos.js';
import { cashConversationHandler } from './conversation.js';
import { rememberCashQueryContext } from './conversation-state.js';
import { cashHelpMessage, cashHelpSection } from './help.js';
import {
  handleCashLedgerDeterministic,
  isCashProtectedNonTransaction
} from './ledger.js';
import { handleCashQuotedManagement } from './quoted-management.js';
import { executeCashAiTransaction } from './ai-transaction-executor.js';

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
    'acknowledgement',
    'unknown'
  ]),
  social_kind: z.enum(['greeting', 'thanks', 'farewell', 'wellbeing', 'ack', 'none']),
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

// Export mantido porque testes e rotas legadas ainda usam esta utilidade. Ela não
// decide o caminho principal: a linguagem natural passa pela OpenAI antes do legado.
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

function destructiveOriginalIsSafe(intent: 'edit' | 'delete', original: string): boolean {
  const value = normalize(original);
  if (/\b(conta|perfil|cadastro|dados pessoais|usuario|usuário)\b/.test(value)) return false;
  if (intent === 'delete') return /\b(apag|exclu|remov|retir|delet|cancel)\w*/.test(value);
  return /\b(edit|alter|mud|corrig|ajust|troc|errei|errado)\w*/.test(value);
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
  try {
    const response = await client.responses.parse({
      model: env.cashOpenaiModel,
      reasoning: { effort: 'minimal' },
      max_output_tokens: 300,
      input: [
        {
          role: 'system',
          content: [
            'Você é a PRIMEIRA camada de compreensão do Arles Cash.',
            'Sua função é entender a intenção em português brasileiro natural: erros, abreviações, gírias, referências como “isso/essas informações” e frases incompletas.',
            'Você NÃO consulta banco, NÃO calcula saldo, NÃO soma valores, NÃO grava e NÃO apaga nada.',
            'Você somente classifica a intenção e, quando útil, reescreve de forma explícita para o backend seguro.',
            'Preserve exatamente valores, sinais, datas, nomes, períodos, números de itens e recorrências. Nunca invente informação.',
            'transaction: dinheiro REAL que já entrou/saiu e deve virar lançamento. Frases curtas como “farmácia 45”, “35 no almoço” ou “entrou 1200 do cliente” podem ser lançamento quando o sentido for factual.',
            'mixed: somente quando a mensagem mistura objetivos de naturezas diferentes, como lançar gasto E perguntar saldo. NÃO use mixed só porque a pessoa quer apagar registros e cofrinhos na mesma mensagem: isso continua sendo delete.',
            'query: consultar registros reais, filtros, valores, lojas, categorias ou períodos.',
            'balance: consultar saldo atual/acumulado ou pedir um resumo/visão geral da situação financeira.',
            'projection: fazer conta/simulação pontual, por exemplo “se eu gastar 50, quanto sobra?”. A conta será feita por script.',
            'pocket: criar/listar/consultar/mover dinheiro em cofrinho, caixinha ou envelope. Se a ação principal for APAGAR um cofrinho, use delete.',
            'forecast_schedule: criar previsão/agendamento futuro ou recorrente. Nunca é lançamento real imediato.',
            'forecast_query: consultar previsões ou saldo projetado.',
            'history: mostrar os últimos registros. “histórico”, “meus registros”, “o que registrei” = history, nunca help.',
            'weekly_report/monthly_report: relatório real da semana/mês.',
            'edit: corrigir lançamento existente.',
            'delete: qualquer exclusão explícita de registro(s), lançamento(s), histórico e/ou cofrinho(s).',
            'undo: restaurar algo que já foi excluído. “coloca ele de novo”, “restaura”, “desfaz exclusão” = undo.',
            'help/plans/trial/categories/schedule: funções administrativas do produto.',
            'acknowledgement: conversa social curta sem ação financeira.',
            'social_kind só é diferente de none quando intent=acknowledgement: greeting para oi/olá/oii/bom dia/boa tarde/boa noite; thanks para obrigado/obrigada/valeu; farewell para tchau/até mais/falou; wellbeing para “tudo bem?”/“como você está?”; ack para ok/certo/beleza/entendi/show.',
            'Exemplos obrigatórios:',
            '“Oii” => acknowledgement/greeting.',
            '“histórico” => history.',
            '“apaga o 2” => delete; NUNCA undo.',
            '“quero que apague todos os lançamentos que fiz anteriormente” => delete.',
            '“apague todas essas informações” => delete e rewritten_text deve tornar a referência explícita, por exemplo “apague todos esses registros mostrados”.',
            '“exclua o cofrinho Poupex e o cofrinho Sonho” => delete, preservando os dois nomes em rewritten_text.',
            '“exclua todos os lançamentos anteriores e delete todos os cofrinhos que fiz” => delete, não mixed.',
            'Para qualquer intent diferente de acknowledgement, social_kind=none.',
            'unknown: somente quando não houver informação suficiente para escolher com segurança.',
            'rewritten_text: torne a intenção explícita sem alterar fatos. Preserve todos os alvos e nomes. Para transaction, preserve valor e descrição e use uma frase curta factual.',
            'clarification: use somente quando intent=unknown e faça uma pergunta curta e específica.',
            'CRÍTICO: cálculo, saldo, total, média, diferença, porcentagem e projeção são sempre executados por script/SQL, nunca pelo modelo.',
            'CRÍTICO: “todo dia 10 gasto 300” = forecast_schedule; “se eu gastar 300” = projection; nenhum deles é transaction.',
            quoted ? `Mensagem citada/respondida: ${quoted}` : 'Não há mensagem citada nesta interação.'
          ].join('\n')
        },
        { role: 'user', content: context.combinedText }
      ],
      text: { format: zodTextFormat(SemanticSchema, 'cash_semantic_intent') }
    });

    const parsed = response.output_parsed;
    if (!parsed) return null;

    const estimatedUsd = estimatedNanoCostUsd(response);
    const usage = (response as any).usage;
    if (usage) {
      console.info(
        `[CashAI] stage=intent model=${env.cashOpenaiModel}` +
        ` message=${context.message.messageId || 'unknown'}` +
        ` input_tokens=${usage.input_tokens ?? 0}` +
        ` output_tokens=${usage.output_tokens ?? 0}` +
        ` estimated_usd=${estimatedUsd.toFixed(8)}`
      );
    }

    return { parsed, estimatedUsd };
  } catch (error) {
    console.error('[CashAI] falha na primeira camada semântica:', error);
    return null;
  }
}

function canonical(intent: SemanticIntent['intent']): string | null {
  const map: Partial<Record<SemanticIntent['intent'], string>> = {
    weekly_report: 'relatório semanal',
    monthly_report: 'relatório mensal',
    undo: 'coloca ele de novo',
    plans: 'planos',
    trial: 'trial',
    categories: 'categorias',
    schedule: 'quando recebo os relatórios?'
  };
  return map[intent] ?? null;
}

export class CashAiFirstHandler implements VerticalHandler {
  async handle(context: VerticalContext): Promise<VerticalResult | null> {
    // Referências explícitas a uma mensagem existente usam o ID do WhatsApp antes de
    // qualquer classificação, pois esse contexto é mais preciso que inferência textual.
    if (context.message.quotedMessageId || context.message.quotedText) {
      const quoted = await handleCashQuotedManagement(context);
      if (quoted) return quoted;
    }

    // A partir daqui, OpenAI é a PRIMEIRA camada de linguagem natural.
    const semantic = await semanticRoute(context);
    if (!semantic) return null;
    const understood = semantic.parsed;

    if (understood.intent === 'unknown') {
      const clarification = understood.clarification?.trim();
      return clarification ? text(clarification) : null;
    }

    if (understood.intent === 'mixed') {
      context.combinedText = understood.rewritten_text?.trim() || context.combinedText;
      return null;
    }

    if (understood.intent === 'transaction') {
      // Barreira determinística pós-IA: mesmo se o classificador errar, perguntas,
      // simulações e previsões conhecidas nunca chegam ao banco como lançamento real.
      if (isCashProtectedNonTransaction(context.combinedText)) return null;

      // SEGUNDA OpenAI: extrai/valida os campos. Só depois o backend persiste.
      return await executeCashAiTransaction(
        context,
        understood.rewritten_text,
        semantic.estimatedUsd
      );
    }

    if (understood.intent === 'acknowledgement') {
      return text(cashSocialReply(understood.social_kind));
    }

    if (understood.intent === 'help') {
      const requested = understood.rewritten_text?.trim() || context.combinedText;
      const section = cashHelpSection(requested) ?? 'menu';
      return text(cashHelpMessage(section));
    }

    if (understood.intent === 'history') {
      // Marca o contexto para frases seguintes como “apaga todas essas informações”.
      await rememberCashQueryContext(context.company.id, context.message.phone, cashHistoryContextMarker);
      return await cashConversationHandler.handle({ ...context, combinedText: 'histórico' });
    }

    // “Resumo/visão geral” usa a composição completa (lançamentos + última posição
    // conhecida dos cofrinhos). “Saldo” puro continua sendo cálculo determinístico.
    if (understood.intent === 'balance') {
      const original = normalize(context.combinedText);
      if (/\b(resumo|visao geral|visao|situacao financeira|como estao minhas financas)\b/.test(original)) {
        return await cashBroadHandler.handle({ ...context, combinedText: 'resumo' });
      }
      return await handleCashLedgerDeterministic({ ...context, combinedText: 'saldo' });
    }

    if (understood.intent === 'projection') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      const result = await handleCashLedgerDeterministic({ ...context, combinedText: rewritten });
      return result ?? null;
    }

    if (understood.intent === 'pocket') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      const result = await handleCashPocketCommand({ ...context, combinedText: rewritten });
      if (result) return result;
      context.combinedText = rewritten;
      return null;
    }

    if (understood.intent === 'forecast_schedule' || understood.intent === 'forecast_query') {
      context.combinedText = understood.rewritten_text?.trim() || context.combinedText;
      return null;
    }

    if (understood.intent === 'delete') {
      if (!destructiveOriginalIsSafe('delete', context.combinedText)) return null;
      return await executeCashAiDeletion(
        context,
        understood.rewritten_text,
        semantic.estimatedUsd
      );
    }

    if (understood.intent === 'edit') {
      if (!destructiveOriginalIsSafe('edit', context.combinedText)) return null;
      const rewritten = understood.rewritten_text?.trim();
      return await cashBroadHandler.handle(rewritten
        ? { ...context, combinedText: rewritten }
        : context);
    }

    if (understood.intent === 'query') {
      const rewritten = understood.rewritten_text?.trim();
      return await cashBroadHandler.handle(rewritten
        ? { ...context, combinedText: rewritten }
        : context);
    }

    const command = canonical(understood.intent);
    if (command) return await cashBroadHandler.handle({ ...context, combinedText: command });

    return null;
  }
}

export const cashAiFirstHandler = new CashAiFirstHandler();
