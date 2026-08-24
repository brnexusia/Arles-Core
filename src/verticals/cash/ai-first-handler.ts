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
import {
  handleCashLedgerDeterministic,
  isCashProtectedNonTransaction
} from './ledger.js';
import { handleCashMixedNarrativeGate } from './mixed-narrative-gate.js';
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

const CalculationSchema = z.object({
  explicit_base: z.number().nonnegative().nullable(),
  operations: z.array(z.object({
    type: z.enum(['income', 'expense']),
    amount: z.number().positive()
  })).max(20)
}).nullable();

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
  help_section: HelpSectionSchema.nullable(),
  rewritten_text: z.string().nullable(),
  calculation: CalculationSchema,
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

function calculationCanonical(calculation: SemanticIntent['calculation']): string | null {
  if (!calculation?.operations?.length) return null;

  const parts = ['calcular saldo'];
  if (calculation.explicit_base != null) {
    parts.push(`considera saldo de ${calculation.explicit_base}`);
  }
  for (const operation of calculation.operations) {
    parts.push(`${operation.type === 'income' ? 'somar' : 'descontar'} ${operation.amount}`);
  }
  return parts.join('; ');
}

// Compatibilidade para testes/rotas legadas. Não participa do roteamento semântico
// principal quando a OpenAI está disponível.
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
  if (!hasCurrentMessage) {
    conversationInput.push({ role: 'user', content: context.combinedText });
  }

  try {
    const response = await client.responses.parse({
      model: env.cashOpenaiModel,
      reasoning: { effort: 'low' },
      max_output_tokens: 420,
      input: [
        {
          role: 'system',
          content: [
            'Você é a camada PRINCIPAL de compreensão do Arles Cash no WhatsApp.',
            `Você recebe até ${cashConversationMemorySize} mensagens recentes da conversa real, alternando user e assistant.`,
            'A ÚLTIMA mensagem com role=user é o pedido atual. Execute/classifique SOMENTE a intenção desse último pedido.',
            'Mensagens anteriores do assistant são contexto e podem conter exemplos/sugestões. NUNCA trate uma sugestão anterior do assistant como se o usuário tivesse pedido aquilo agora.',
            'Use o histórico para resolver referências naturais: “isso”, “esses”, “essas informações”, “o 2”, “eles”, “todos esses”, “o que eu registrei”, “aquela lista”, “de hoje”, “as coisas”, “o que eu paguei”, “depois disso”, etc.',
            'Ao resolver referências, dê prioridade às mensagens do usuário imediatamente anteriores e aos valores explicitamente citados na mensagem atual.',
            'Se o usuário citar um valor-base explicitamente agora, esse valor vence saldo global, totais antigos e outros números parecidos existentes no histórico.',
            'Se o usuário mudar de assunto ou der uma nova ordem explícita, a nova ordem tem prioridade total sobre confirmações ou assuntos antigos.',
            'Sua função é ENTENDER português brasileiro natural, erros, abreviações, gírias, frases incompletas e múltiplas linhas.',
            'Você NÃO consulta banco, NÃO calcula saldo, NÃO soma valores, NÃO grava e NÃO apaga nada.',
            'Você classifica a intenção e extrai/reformula os fatos necessários para executores seguros do backend.',
            'Preserve exatamente valores, sinais, datas, nomes, períodos, números de itens, cofrinhos e recorrências. Nunca invente informação.',
            '',
            'INTENÇÕES:',
            'transaction: dinheiro REAL que já entrou/saiu e deve virar lançamento.',
            'mixed: a última mensagem contém objetivos de naturezas diferentes, por exemplo registrar um gasto E perguntar saldo. Reescreva todos os objetivos, um por linha.',
            'query: consultar/listar/somar registros já salvos, com filtros de data, descrição, categoria ou período.',
            'balance: posição financeira GLOBAL/ACUMULADA atual — saldo, quanto ainda tem, total disponível, entradas/saídas acumuladas. NÃO use balance quando o usuário pede uma conta ancorada em um valor específico.',
            'projection: simulação hipotética OU cálculo contextual ancorado em um valor específico, inclusive “quanto sobrou dos 970 depois que paguei as coisas?”.',
            'pocket: criar/listar/consultar/mover dinheiro em cofrinho. Se a ação principal for APAGAR cofrinho(s), use delete.',
            'forecast_schedule: criar previsão/agendamento futuro ou recorrente.',
            'forecast_query: consultar previsões ou saldo projetado.',
            'history: mostrar os últimos registros numerados.',
            'weekly_report/monthly_report: relatório real da semana/mês.',
            'edit: corrigir lançamento existente.',
            'delete: QUALQUER exclusão explícita de registro(s), lançamento(s), histórico e/ou cofrinho(s), inclusive vários números na mesma mensagem.',
            'undo: SOMENTE quando o usuário atual explicitamente pede restaurar/desfazer uma exclusão anterior.',
            'help: o usuário está pedindo explicação de como usar algo; preencha help_section.',
            'plans/trial/categories/schedule: funções administrativas do produto.',
            'acknowledgement: conversa social curta sem ação financeira.',
            'unknown: somente quando nem o histórico permite saber com segurança o que o usuário quer.',
            '',
            'CÁLCULO CONTEXTUAL — REGRA PRIORITÁRIA:',
            'Quando o usuário pergunta quanto sobrou/restou/ficou DE/DOS um valor específico depois de gastos, pagamentos ou entradas mencionados na conversa recente, classifique como projection, NÃO como balance.',
            'Preencha calculation.explicit_base com o valor-base citado pelo usuário e calculation.operations com cada operação relevante mencionada nas mensagens recentes do USER. Não use números das respostas do assistant como novas operações.',
            'Para “as coisas”, “esses gastos”, “o que eu paguei” e referências parecidas, use o bloco financeiro mais próximo imediatamente anterior ao pedido atual.',
            'Não calcule o resultado dentro da IA. Apenas extraia base e operações; o backend fará a matemática.',
            'Exemplo: user antes disse “paguei 77 da unha, 140 de skin care e 24 de lanche”; agora pergunta “quanto sobrou dos 970 depois que paguei as coisas?” => intent=projection, explicit_base=970 e três operações expense: 77, 140, 24.',
            'Se o usuário disser apenas “quanto sobrou?” sem valor-base nem operações específicas referidas, isso é balance global.',
            'Se houver valor-base explícito mas o histórico não permitir identificar quais operações ele quer aplicar, use unknown e faça uma pergunta curta em vez de responder o saldo global.',
            '',
            'REGRAS IMPORTANTES PARA OS CASOS REAIS:',
            '“Poderia me informar o valor total dos lançamentos?” => balance; o backend mostrará entradas, saídas e saldo.',
            '“Me mande o valor que eu registrei hoje” => query e rewritten_text deve explicitar “listar/somar as movimentações registradas hoje”, NÃO balance acumulado.',
            '“Quanto que ainda tem nos registros?” => balance.',
            '“Quero que exclua todos os lançamentos que já fiz” => delete. NUNCA undo.',
            '“Apague todos esses lançamentos” => delete; use o histórico para entender se “esses” significa a lista recém-mostrada ou todos os registros mencionados.',
            '“Apaga o 2” => delete. NUNCA undo.',
            '“Apaga o 1. Apaga o 2. Apaga o 3. Apaga o 4. Apaga o 5. Apaga o 6” => delete; preserve TODOS os índices no rewritten_text.',
            '“Exclua o cofrinho Poupex e o cofrinho Sonho” => delete; preserve os dois nomes.',
            '“Exclua todos os lançamentos anteriores e delete todos os cofrinhos que fiz” => delete, não mixed.',
            'Uma resposta anterior do assistant dizendo “se quiser desfazer, diga coloca ele de novo” NÃO torna o próximo pedido um undo.',
            '',
            'Para transaction, rewritten_text deve manter valor e descrição factual.',
            'Para query, rewritten_text deve tornar período/filtro/referente explícito usando o contexto recente.',
            'Para projection, preencha calculation sempre que houver operandos claros; rewritten_text pode resumir o pedido, mas NÃO precisa fazer a conta.',
            'Para qualquer intent que não seja um cálculo/simulação, calculation deve ser null.',
            'Para delete/edit/pocket/forecast, rewritten_text deve preservar todos os alvos e detalhes mencionados.',
            'Para acknowledgement, social_kind identifica greeting/thanks/farewell/wellbeing/ack; nos demais intents use none.',
            'Para help, help_section deve ser menu/register/query/pockets/forecasts/manage/reports/plans; nos demais intents use null.',
            'clarification só é preenchida quando intent=unknown e deve ser uma pergunta curta e específica.',
            'CRÍTICO: matemática, saldo, total, média, diferença, porcentagem e projeção são executados por script/SQL, nunca pelo modelo.',
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
    if (context.message.quotedMessageId || context.message.quotedText) {
      const quoted = await handleCashQuotedManagement(context);
      if (quoted) return quoted;
    }

    const semantic = await semanticRoute(context);
    if (!semantic) {
      // Com OPENAI_API_KEY configurada, uma falha da IA não cai em classificadores
      // naturais por regex. Falha fechada: melhor pedir repetição do que executar errado.
      return client
        ? text('Tive uma falha ao interpretar sua mensagem agora. Pode repetir a mesma frase em alguns segundos?')
        : null;
    }
    const understood = semantic.parsed;
    const canonicalCalculation = calculationCanonical(understood.calculation);
    const anchoredCalculation = Boolean(
      understood.calculation?.explicit_base != null && understood.calculation.operations.length
    );

    if (understood.intent === 'unknown') {
      return text(understood.clarification?.trim() || 'Não consegui identificar exatamente o que você quer fazer. Pode me dizer em uma frase curta?');
    }

    if (understood.intent === 'transaction') {
      // Barreira de segurança contra persistência acidental. Ela não decide a intenção;
      // a decisão já veio da IA contextual acima.
      if (isCashProtectedNonTransaction(context.combinedText)) {
        return text('Entendi que essa mensagem não deve virar um lançamento real. Não registrei nada. Pode repetir dizendo se é consulta, simulação ou previsão?');
      }
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
      return text(cashHelpMessage((understood.help_section ?? 'menu') as CashHelpSection));
    }

    if (understood.intent === 'history') {
      await rememberCashQueryContext(context.company.id, context.message.phone, cashHistoryContextMarker);
      return await cashConversationHandler.handle({ ...context, combinedText: 'histórico' });
    }

    // Salvaguarda contra a confusão que originou o bug: se a própria IA extraiu uma
    // conta ancorada em valor específico, executamos a matemática determinística mesmo
    // que o rótulo tenha vindo como balance/query.
    if (anchoredCalculation && canonicalCalculation && (understood.intent === 'balance' || understood.intent === 'query')) {
      const result = await handleCashLedgerDeterministic({ ...context, combinedText: canonicalCalculation });
      if (result) return result;
    }

    if (understood.intent === 'balance') {
      return await handleCashLedgerDeterministic({ ...context, combinedText: 'saldo' });
    }

    if (understood.intent === 'projection') {
      const rewritten = canonicalCalculation || understood.rewritten_text?.trim() || context.combinedText;
      const result = await handleCashLedgerDeterministic({ ...context, combinedText: rewritten });
      return result ?? text('Entendi a conta, mas não consegui calcular com os dados fornecidos.');
    }

    if (understood.intent === 'delete') {
      return await executeCashAiDeletion(
        context,
        understood.rewritten_text,
        semantic.estimatedUsd
      );
    }

    if (understood.intent === 'pocket') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      const result = await executePocketCanonical(context, rewritten);
      return result ?? text('Entendi a ação de cofrinho, mas faltou algum dado para executá-la com segurança. Diga qual cofrinho e o que deseja fazer.');
    }

    if (understood.intent === 'forecast_schedule' || understood.intent === 'forecast_query') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      const result = await handleCashScheduleDeterministic({ ...context, combinedText: rewritten });
      return result ?? text('Entendi a previsão/agendamento, mas não consegui executá-la com segurança. Informe valor e data/recorrência.');
    }

    if (understood.intent === 'mixed') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      const result = await handleCashMixedNarrativeGate({ ...context, combinedText: rewritten });
      return result ?? text('Entendi que há mais de uma ação na mensagem, mas não consegui separar todas com segurança. Pode reenviar em duas frases?');
    }

    if (understood.intent === 'edit' || understood.intent === 'query') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      const result = await cashBroadHandler.handle({ ...context, combinedText: rewritten });
      return result ?? text('Entendi o pedido, mas não consegui localizar os dados necessários para concluir.');
    }

    const command = canonical(understood.intent);
    if (command) {
      const result = await cashBroadHandler.handle({ ...context, combinedText: command });
      return result ?? text('Entendi o pedido, mas não consegui concluir essa ação agora.');
    }

    return text('Entendi sua mensagem, mas não consegui concluir a ação com segurança. Pode repetir o pedido?');
  }
}

export const cashAiFirstHandler = new CashAiFirstHandler();
