import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { VerticalContext, VerticalHandler, VerticalResult } from '../vertical.js';
import { cashBroadHandler } from './broad-handler.js';
import { cashHelpMessage, cashHelpSection } from './help.js';
import { deletionTarget } from './management.js';

const SemanticSchema = z.object({
  intent: z.enum([
    'transaction',
    'query',
    'balance',
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
  rewritten_text: z.string().nullable()
});

type SemanticIntent = z.infer<typeof SemanticSchema>;

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

export function isCashNaturalRecordListRequest(input: string): boolean {
  const value = normalize(input).replace(/[!?.,]+$/g, '').trim();
  if (!value || /\b(como|ajuda|ensina|explica)\b/.test(value)) return false;

  return /^(?:(?:me )?(?:fala|mostra|mostre|lista|liste|traz|traga|diz|fale)\s+)?(?:(?:ai|aí)\s+)?(?:os\s+)?(?:meus\s+)?(?:registros|registos|lancamentos|movimentacoes)(?:\s+(?:ai|aí|pra mim|para mim))?$/.test(value)
    || /^(?:quais|qual)\s+(?:sao\s+)?(?:os\s+)?(?:meus\s+)?(?:registros|registos|lancamentos|movimentacoes)$/.test(value);
}

function obviousTransaction(input: string): boolean {
  const value = normalize(input);
  const hasMoney = /(?:r\$\s*)?\d+(?:\.\d{3})*(?:[.,]\d{1,2})?/.test(value);
  const movement = /\b(gastei|gasto|paguei|pague|comprei|recebi|ganhei|entrou|vendi|faturei|guardei|reservei|separei)\b/.test(value);
  return hasMoney && movement;
}

function destructiveOriginalIsSafe(intent: 'edit' | 'delete', original: string): boolean {
  const value = normalize(original);
  if (/\b(conta|perfil|cadastro|dados pessoais|usuario|usuário)\b/.test(value)) return false;
  if (intent === 'delete') return /\b(apag|exclu|remov|retir|delet|cancela(?:r)?\s+(?:o\s+)?(?:registro|lancamento|lançamento))\w*/.test(value);
  return /\b(edit|alter|mud|corrig|ajust|troc|errei|errado)\w*/.test(value);
}

async function semanticRoute(context: VerticalContext): Promise<SemanticIntent | null> {
  if (!client) return null;

  const quoted = String(context.message.quotedText ?? '').trim();
  try {
    const response = await client.responses.parse({
      model: env.openaiModel,
      input: [
        {
          role: 'system',
          content: [
            'Você é a camada principal de compreensão do Arles Cash, um assistente financeiro pessoal no WhatsApp.',
            'Entenda português brasileiro natural, erros, gírias, frases incompletas e contexto de mensagem respondida.',
            'Você NÃO consulta banco, NÃO calcula saldo real e NÃO inventa lançamentos. Apenas classifica e reescreve para o motor seguro executar.',
            'transaction: a pessoa informa um lançamento novo. Não reescreva; o parser financeiro fará a extração.',
            'query: quer consultar registros, gastos, receitas, lojas, categorias, períodos ou listas. rewritten_text deve ser uma pergunta explícita e curta preservando filtros.',
            'Pedidos como “fala meus registros”, “me mostra meus lançamentos” ou “lista meus registros” são query, nunca help.',
            'Quando um pedido de lista/consulta não trouxer período, considere hoje.',
            'balance: quer saber saldo, quanto sobrou ou situação financeira geral.',
            'history: quer ver lançamentos recentes quando disser explicitamente histórico, últimos ou recentes.',
            'weekly_report/monthly_report: quer relatório/fechamento da semana ou mês.',
            'edit: quer explicitamente corrigir um lançamento existente.',
            'delete: quer explicitamente apagar um lançamento existente. Nunca use para apagar conta, cadastro, perfil ou dados pessoais.',
            'undo: quer desfazer a última exclusão de lançamento.',
            'help: quer aprender como usar alguma função. Se for específico, use rewritten_text como uma destas opções: “ajuda registrar”, “ajuda consultar”, “ajuda editar”, “ajuda relatorios” ou “ajuda planos”. Se for geral, use “ajuda”.',
            'Importante: “como consulto meus gastos?” é help; “quanto gastei hoje?” é query.',
            'plans: quer preço, assinatura, plano ou pagar.',
            'trial: pergunta sobre teste grátis, período gratuito, validade ou status do trial.',
            'categories: pergunta sobre categorias.',
            'schedule: pergunta quando relatórios automáticos são enviados.',
            'acknowledgement: resposta social curta sem nova ação, como certo, entendi, beleza, obrigado.',
            'unknown: conversa que não cabe com segurança nas funções acima.',
            'Se a pessoa disser que já falou/citou os gastos acima, ou pedir uma lista do que gastou, isso é query — não transforme a frase em termo de busca literal.',
            'Se houver mensagem citada, use-a como contexto, sem inventar conteúdo.',
            quoted ? `Mensagem citada/respondida: ${quoted}` : 'Não há mensagem citada nesta interação.'
          ].join('\n')
        },
        { role: 'user', content: context.combinedText }
      ],
      text: { format: zodTextFormat(SemanticSchema, 'cash_semantic_intent') }
    });
    return response.output_parsed ?? null;
  } catch (error) {
    console.error('[CashAiFirstHandler] falha na camada semântica:', error);
    return null;
  }
}

function canonical(intent: SemanticIntent['intent']): string | null {
  const map: Partial<Record<SemanticIntent['intent'], string>> = {
    balance: 'saldo',
    history: 'histórico',
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
    // Pedidos diretos de lista são determinísticos e não precisam gastar IA.
    // Sem período explícito, a regra do Cash é consultar somente hoje.
    if (isCashNaturalRecordListRequest(context.combinedText)) {
      return await cashBroadHandler.handle({ ...context, combinedText: 'quais foram meus registros hoje?' });
    }

    // Exclusões diretas têm prioridade sobre a IA. Isso é especialmente importante
    // para frases curtas de continuidade como “cancela ele” e “apaga esse”, que se
    // referem ao lançamento recém-tratado e não podem ser reclassificadas como edição.
    if (deletionTarget(context.combinedText)) {
      return await cashBroadHandler.handle(context);
    }

    // Lançamentos claros seguem para o parser financeiro. O parser também usa IA
    // como extrator semântico, evitando uma chamada duplicada só para classificar.
    if (obviousTransaction(context.combinedText)) {
      return await cashBroadHandler.handle(context);
    }

    const understood = await semanticRoute(context);
    if (!understood || understood.intent === 'unknown' || understood.intent === 'transaction') {
      return await cashBroadHandler.handle(context);
    }

    if (understood.intent === 'acknowledgement') {
      return text('Perfeito 😊 Pode continuar falando comigo do seu jeito.');
    }

    if (understood.intent === 'help') {
      const requested = understood.rewritten_text?.trim() || context.combinedText;
      const section = cashHelpSection(requested) ?? 'menu';
      return text(cashHelpMessage(section));
    }

    if (understood.intent === 'edit' || understood.intent === 'delete') {
      if (!destructiveOriginalIsSafe(understood.intent, context.combinedText)) {
        return await cashBroadHandler.handle(context);
      }
      const rewritten = understood.rewritten_text?.trim();
      return await cashBroadHandler.handle(rewritten
        ? { ...context, combinedText: rewritten }
        : context);
    }

    if (understood.intent === 'query') {
      const rewritten = understood.rewritten_text?.trim();
      if (rewritten) {
        return await cashBroadHandler.handle({ ...context, combinedText: rewritten });
      }
      return await cashBroadHandler.handle(context);
    }

    const command = canonical(understood.intent);
    if (command) {
      return await cashBroadHandler.handle({ ...context, combinedText: command });
    }

    return await cashBroadHandler.handle(context);
  }
}

export const cashAiFirstHandler = new CashAiFirstHandler();
