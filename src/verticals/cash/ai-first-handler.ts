import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { VerticalContext, VerticalHandler, VerticalResult } from '../vertical.js';
import { cashBroadHandler } from './broad-handler.js';
import { handleCashPocketCommand } from './cofrinhos.js';
import { cashHelpMessage, cashHelpSection } from './help.js';
import {
  handleCashLedgerDeterministic,
  isCashProtectedNonTransaction
} from './ledger.js';
import { deletionTarget } from './management.js';

const SemanticSchema = z.object({
  intent: z.enum([
    'transaction',
    'query',
    'balance',
    'projection',
    'pocket',
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
  if (isCashProtectedNonTransaction(input)) return false;
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
    console.info(`[CashAI] fallback semântico acionado company=${context.company.id} phone=*${context.message.phone.slice(-4)}`);
    const response = await client.responses.parse({
      model: env.openaiModel,
      input: [
        {
          role: 'system',
          content: [
            'Você é a camada de FALLBACK de compreensão do Arles Cash, um assistente financeiro pessoal no WhatsApp.',
            'A maior parte das frases já foi resolvida por regras. Você entra apenas quando a linguagem ficou fora dessas rotas.',
            'Entenda português brasileiro natural, erros, gírias, frases incompletas e contexto de mensagem respondida.',
            'Você NÃO consulta banco, NÃO calcula saldo real, NÃO salva e NÃO apaga nada. Apenas classifica e reescreve para o Core seguro executar.',
            'transaction: a pessoa afirma um lançamento NOVO e REAL que já aconteceu/acontece. Nunca classifique hipótese, pergunta ou simulação como transaction.',
            'query: quer consultar registros, gastos, receitas, lojas, categorias, períodos ou listas. rewritten_text deve preservar filtros.',
            'balance: quer saber o saldo real atual/acumulado. rewritten_text pode ser “saldo”.',
            'projection: quer simular quanto sobrará/terá caso gaste ou receba um valor. rewritten_text DEVE manter todos os valores e virar frase explícita como “se eu gastar 5,67, quanto fica meu saldo?”.',
            'pocket: quer criar/listar/consultar um cofrinho, caixinha, envelope ou separação de dinheiro. Reescreva usando a palavra “cofrinho” e preserve o nome. Ex.: “faz uma caixinha trabalho” -> “criar cofrinho Trabalho”.',
            'history: quer ver lançamentos recentes quando disser explicitamente histórico, últimos ou recentes.',
            'weekly_report/monthly_report: quer relatório/fechamento da semana ou mês.',
            'edit: quer explicitamente corrigir um lançamento existente.',
            'delete: quer explicitamente apagar um lançamento existente. Nunca use para apagar conta, cadastro, perfil ou dados pessoais.',
            'undo: quer desfazer a última exclusão de lançamento.',
            'help: quer aprender como usar alguma função.',
            'plans: quer preço, assinatura, plano ou pagar.',
            'trial: pergunta sobre teste grátis, período gratuito, validade ou status do trial.',
            'categories: pergunta sobre categorias.',
            'schedule: pergunta quando relatórios automáticos são enviados.',
            'acknowledgement: resposta social curta sem nova ação.',
            'unknown: conversa que não cabe com segurança nas funções acima.',
            'IMPORTANTE: “tenho saldo de 10, se eu gastar 5,67 quanto fica?” é projection, NUNCA transaction.',
            'IMPORTANTE: “se eu receber 100 e gastar 20 quanto terei?” é projection, NUNCA dois lançamentos.',
            'IMPORTANTE: números em perguntas não são prova de lançamento.',
            'Se houver mensagem citada, use-a como contexto sem inventar conteúdo.',
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
    if (isCashNaturalRecordListRequest(context.combinedText)) {
      return await cashBroadHandler.handle({ ...context, combinedText: 'quais foram meus registros hoje?' });
    }

    if (deletionTarget(context.combinedText)) return await cashBroadHandler.handle(context);

    // Uma segunda trava de leitura/cálculo antes do parser. Normalmente AccessHandler
    // já resolveu isso; aqui protege chamadas internas e reescritas futuras.
    if (isCashProtectedNonTransaction(context.combinedText)) {
      const ledger = await handleCashLedgerDeterministic(context);
      if (ledger) return ledger;
    }

    if (obviousTransaction(context.combinedText)) return await cashBroadHandler.handle(context);

    const understood = await semanticRoute(context);
    if (!understood || understood.intent === 'unknown') return await cashBroadHandler.handle(context);

    if (understood.intent === 'transaction') {
      if (isCashProtectedNonTransaction(context.combinedText)) {
        return text('Entendi que você está fazendo uma pergunta/simulação, então não registrei nenhum lançamento. Pode dizer o cenário e eu calculo para você.');
      }
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

    if (understood.intent === 'balance') {
      return await handleCashLedgerDeterministic({ ...context, combinedText: 'saldo' });
    }

    if (understood.intent === 'projection') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      const result = await handleCashLedgerDeterministic({ ...context, combinedText: rewritten });
      if (result) return result;
      return text('Entendi que é uma simulação e não registrei nada. Me diga o valor que entraria/sairia e eu calculo com seu saldo atual.');
    }

    if (understood.intent === 'pocket') {
      const rewritten = understood.rewritten_text?.trim() || context.combinedText;
      const result = await handleCashPocketCommand({ ...context, combinedText: rewritten });
      if (result) return result;
      return text('Entendi que você está falando de um cofrinho. Pode dizer, por exemplo, “criar cofrinho Emprego”, “meus cofrinhos” ou “saldo do cofrinho Emprego”.');
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
      return await cashBroadHandler.handle(rewritten
        ? { ...context, combinedText: rewritten }
        : context);
    }

    const command = canonical(understood.intent);
    if (command) return await cashBroadHandler.handle({ ...context, combinedText: command });
    return await cashBroadHandler.handle(context);
  }
}

export const cashAiFirstHandler = new CashAiFirstHandler();
