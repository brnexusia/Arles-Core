import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { VerticalContext, VerticalHandler, VerticalResult } from '../vertical.js';
import { cashBroadHandler } from './broad-handler.js';

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
            'Sua tarefa é entender a intenção real da mensagem em português brasileiro natural, com erros, gírias, frases incompletas e contexto de mensagem respondida.',
            'Você NÃO consulta banco, NÃO calcula saldo real e NÃO inventa lançamentos. Apenas classifica e, quando necessário, reescreve a intenção para o motor determinístico executar com segurança.',
            'transaction: a pessoa está informando um lançamento financeiro novo. Não reescreva; o parser financeiro fará a extração.',
            'query: quer consultar registros, gastos, receitas, lojas, categorias, períodos, listas ou perguntas sobre o que já registrou. rewritten_text deve ser uma pergunta explícita e curta que preserve filtros e período. Ex.: “tem como fazer uma lista organizada do que eu gastei” => “quais foram meus gastos este mês?”.',
            'balance: quer saber saldo, quanto sobrou, situação financeira ou balanço geral.',
            'history: quer ver lançamentos recentes sem filtro específico.',
            'weekly_report/monthly_report: quer relatório ou fechamento da semana/mês.',
            'edit: quer explicitamente corrigir um lançamento existente. rewritten_text deve manter alvo e alteração.',
            'delete: quer explicitamente apagar um lançamento existente. Nunca use para apagar conta, cadastro, perfil ou dados pessoais.',
            'undo: quer desfazer a última exclusão de lançamento.',
            'help: quer saber como usar, o que pode fazer ou quais funções existem.',
            'plans: quer preço, assinatura, plano ou pagar.',
            'trial: pergunta sobre teste grátis, período gratuito, validade ou status do trial.',
            'categories: pergunta sobre categorias.',
            'schedule: pergunta quando relatórios automáticos são enviados.',
            'acknowledgement: resposta social curta sem nova ação, como certo, entendi, beleza, obrigado.',
            'unknown: conversa que não cabe com segurança nas funções acima.',
            'Se a pessoa disser que já falou/citou os gastos acima, ou pedir uma lista do que gastou, isso é query — não transforme a frase em termo de busca literal.',
            'Se houver uma mensagem citada, use-a como contexto, mas não invente nada que não esteja nela.',
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
    help: 'ajuda',
    plans: 'planos',
    trial: 'trial',
    categories: 'categorias',
    schedule: 'quando recebo os relatórios?'
  };
  return map[intent] ?? null;
}

export class CashAiFirstHandler implements VerticalHandler {
  async handle(context: VerticalContext): Promise<VerticalResult | null> {
    // Lançamentos claros seguem para o parser financeiro, que também usa IA como
    // extrator principal. Isso evita uma chamada semântica redundante para “gastei 50”.
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
