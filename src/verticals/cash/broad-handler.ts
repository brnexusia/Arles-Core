import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { VerticalContext, VerticalHandler, VerticalResult } from '../vertical.js';
import { cashConversationHandler } from './conversation.js';
import { routeCashInput, type CashBroadRoute } from './broad-routing.js';
import { cashService } from './service.js';
import { formatBrazilDate } from './time.js';

const BroadFallbackSchema = z.object({
  intent: z.enum([
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
    'unknown'
  ]),
  rewritten_text: z.string().nullable()
});

const client = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function resultText(result: VerticalResult | null): string {
  if (!result) return '';
  return result.actions
    .filter(action => action.type === 'text')
    .map(action => action.type === 'text' ? action.text : '')
    .join('\n');
}

function isFinalFallback(result: VerticalResult | null): boolean {
  const value = resultText(result).trimStart();
  return value.startsWith('Não consegui interpretar isso com segurança') || value.startsWith('Hmm, não entendi bem');
}

function categoriesMessage(): string {
  return [
    '📂 Categorias automáticas do Arles Cash',
    '',
    '🍽️ Alimentação — mercado, padaria, almoço, delivery...',
    '🚗 Transporte — Uber, gasolina, ônibus, estacionamento...',
    '🏥 Saúde — farmácia, consulta, exame, remédio...',
    '🏠 Moradia — aluguel, água, luz, internet, condomínio...',
    '📚 Educação — escola, curso, faculdade, livros...',
    '👤 Pessoal — roupas, academia, salão, shopping...',
    '💰 Receita — salário, freela, recebimentos...',
    '📦 Outros — quando não se encaixar nas anteriores.',
    '',
    'Você não precisa escolher a categoria ao registrar; eu classifico automaticamente.'
  ].join('\n');
}

function scheduleMessage(): string {
  return [
    '📅 Relatórios automáticos',
    '',
    '• Toda segunda-feira, 8h → resumo da semana anterior',
    '• Todo dia 1, 8h → resumo do mês anterior',
    '',
    'Você também pode pedir a qualquer momento: “relatório semanal” ou “relatório mensal”.'
  ].join('\n');
}

function planLabel(planKey: string | null): string {
  if (planKey === 'cash_monthly') return 'Mensal';
  if (planKey === 'cash_semiannual') return 'Semestral';
  if (planKey === 'cash_annual') return 'Anual';
  return 'Ativo';
}

async function trialMessage(companyId: string): Promise<string> {
  const state = await cashService.accessState(companyId);
  if (state.subscription_status === 'trial' && state.trial_ends_at) {
    const ms = state.trial_ends_at.getTime() - Date.now();
    const days = Math.max(0, Math.ceil(ms / 86_400_000));
    return [
      '🎁 Seu trial está ativo.',
      `📅 Termina em ${formatBrazilDate(state.trial_ends_at)}.`,
      `⏳ ${days} dia${days === 1 ? '' : 's'} restante${days === 1 ? '' : 's'}.`,
      '',
      'Durante o trial você tem acesso completo ao Arles Cash.'
    ].join('\n');
  }

  if (state.subscription_status === 'active') {
    return [
      '✅ Seu Arles Cash está ativo.',
      `📌 Plano: ${planLabel(state.plan_key)}`,
      state.subscription_current_period_end
        ? `📅 Acesso atual até ${formatBrazilDate(state.subscription_current_period_end)}.`
        : ''
    ].filter(Boolean).join('\n');
  }

  return [
    '⚠️ Seu acesso não está ativo no momento.',
    '',
    cashService.paymentMenu()
  ].join('\n');
}

async function specialRoute(context: VerticalContext, route: Exclude<CashBroadRoute, { kind: 'rewrite'; text: string } | null>): Promise<VerticalResult> {
  if (route.kind === 'plans') {
    return text(['💳 Planos do Arles Cash', '', cashService.paymentMenu()].join('\n'));
  }
  if (route.kind === 'trial') return text(await trialMessage(context.company.id));
  if (route.kind === 'categories') return text(categoriesMessage());
  return text(scheduleMessage());
}

function safeDestructiveRewrite(intent: 'edit' | 'delete', value: string): boolean {
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  if (/\b(conta|perfil|cadastro|dados pessoais)\b/.test(normalized)) return false;
  if (intent === 'delete') return /\b(apag|exclu|remov|retir|cancel|delet)\w*/.test(normalized);
  return /\b(edit|alter|mud|corrig|ajust|troc)\w*/.test(normalized);
}

async function broadAiFallback(input: string) {
  if (!client) return { intent: 'unknown' as const, rewritten_text: null as string | null };
  try {
    const response = await client.responses.parse({
      model: env.openaiModel,
      input: [
        {
          role: 'system',
          content: [
            'Você é o roteador de último recurso do Arles Cash no WhatsApp.',
            'Classifique a intenção do usuário em uma das rotas suportadas.',
            'query: consultar lançamentos, valores, períodos, lojas, categorias ou filtros. rewritten_text deve virar uma pergunta explícita, ex.: “quais foram meus registros hoje?” ou “quanto gastei na SHEIN este mês?”.',
            'balance: saldo, balanço ou situação financeira geral.',
            'history: últimos registros sem um período específico.',
            'weekly_report/monthly_report: fechamento ou relatório da semana/mês.',
            'edit: usuário explicitamente quer corrigir um lançamento. rewritten_text deve conter verbo de edição e alvo seguro, ex.: “edita o último” ou “muda o último para 20 reais”.',
            'delete: usuário explicitamente quer apagar um lançamento. rewritten_text deve conter verbo de exclusão e alvo seguro, ex.: “apaga o último” ou “remove o 2”. Nunca use delete para conta, cadastro ou dados pessoais.',
            'undo: restaurar o último lançamento excluído.',
            'help: como usar, funções, comandos ou exemplos.',
            'plans: preço, assinatura, planos ou reativação.',
            'trial: duração/status/fim do período gratuito ou plano atual.',
            'categories: categorias automáticas.',
            'schedule: quando os relatórios automáticos são enviados.',
            'unknown: conversa fora dessas funções ou quando não for seguro inferir.',
            'Não calcule valores, não invente registros e não transforme conversa casual em lançamento financeiro.'
          ].join('\n')
        },
        { role: 'user', content: input }
      ],
      text: { format: zodTextFormat(BroadFallbackSchema, 'cash_broad_route') }
    });
    return response.output_parsed ?? { intent: 'unknown' as const, rewritten_text: null };
  } catch (error) {
    console.error('[CashBroadHandler] falha no roteador de IA:', error);
    return { intent: 'unknown' as const, rewritten_text: null };
  }
}

async function retryCanonical(context: VerticalContext, rewrittenText: string): Promise<VerticalResult | null> {
  return await cashConversationHandler.handle({ ...context, combinedText: rewrittenText });
}

export class CashBroadHandler implements VerticalHandler {
  async handle(context: VerticalContext): Promise<VerticalResult | null> {
    const route = routeCashInput(context.combinedText);

    if (route && route.kind !== 'rewrite') return await specialRoute(context, route);

    const firstContext = route?.kind === 'rewrite'
      ? { ...context, combinedText: route.text }
      : context;
    const first = await cashConversationHandler.handle(firstContext);
    if (!isFinalFallback(first)) return first;

    const fallback = await broadAiFallback(context.combinedText);

    if (fallback.intent === 'plans') return text(['💳 Planos do Arles Cash', '', cashService.paymentMenu()].join('\n'));
    if (fallback.intent === 'trial') return text(await trialMessage(context.company.id));
    if (fallback.intent === 'categories') return text(categoriesMessage());
    if (fallback.intent === 'schedule') return text(scheduleMessage());

    const canonical: Record<string, string> = {
      balance: 'saldo',
      history: 'histórico',
      weekly_report: 'relatório semanal',
      monthly_report: 'relatório mensal',
      undo: 'coloca ele de novo',
      help: 'ajuda'
    };

    const direct = canonical[fallback.intent];
    if (direct) return await retryCanonical(context, direct);

    if ((fallback.intent === 'query' || fallback.intent === 'edit' || fallback.intent === 'delete') && fallback.rewritten_text?.trim()) {
      const rewritten = fallback.rewritten_text.trim();
      if ((fallback.intent === 'edit' || fallback.intent === 'delete') && !safeDestructiveRewrite(fallback.intent, rewritten)) {
        return first;
      }
      const retry = await retryCanonical(context, rewritten);
      if (!isFinalFallback(retry)) return retry;
    }

    return first;
  }
}

export const cashBroadHandler = new CashBroadHandler();
