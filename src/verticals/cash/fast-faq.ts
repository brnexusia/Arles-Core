import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashPaymentMenuForCompany } from './checkout.js';
import { cashService } from './service.js';
import { formatBrazilDate } from './time.js';

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[!?.,]+$/g, '');
}

function matches(value: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(value));
}

async function trialAnswer(companyId: string): Promise<VerticalResult> {
  const state = await cashService.accessState(companyId);
  const lines = [
    '🎁 Trial é o teste grátis do Arles Cash por 7 dias.',
    'Nesse período você usa normalmente os registros, consultas, saldo e relatórios.'
  ];

  if (state.subscription_status === 'trial' && state.trial_ends_at) {
    const remainingMs = state.trial_ends_at.getTime() - Date.now();
    const days = Math.max(0, Math.ceil(remainingMs / 86_400_000));
    lines.push('', `O seu está ativo até ${formatBrazilDate(state.trial_ends_at)} — faltam ${days} dia${days === 1 ? '' : 's'}.`);
  } else if (state.subscription_status === 'active') {
    lines.push('', 'No seu caso, você já está com um plano pago ativo ✅');
  } else {
    lines.push('', 'Seu período gratuito não está ativo no momento.');
  }

  return text(lines.join('\n'));
}

async function plansAnswer(companyId: string): Promise<VerticalResult> {
  return text([
    '💳 Planos do Arles Cash:',
    '',
    await cashPaymentMenuForCompany(companyId)
  ].join('\n'));
}

export async function fastCashFaq(context: VerticalContext): Promise<VerticalResult | null> {
  const value = normalize(context.combinedText);
  if (!value) return null;

  if (matches(value, [
    /^(o que e|oq e|que e|o que significa) (o )?trial$/,
    /^(como funciona|como funciona o) (trial|teste gratis|periodo gratuito)$/,
    /^(trial|teste gratis|periodo gratuito)$/
  ])) {
    return await trialAnswer(context.company.id);
  }

  if (matches(value, [
    /^(quanto custa|qual o valor|quais os valores|preco|precos|planos|quais os planos)$/,
    /^(quanto custa o arles cash|quais os planos do arles cash|como assino|como pagar|quero assinar)$/
  ])) {
    return await plansAnswer(context.company.id);
  }

  if (matches(value, [
    /^(como funciona|como funciona o arles cash|o que e o arles cash|o que o arles cash faz)$/,
    /^(pra que serve|para que serve)( o arles cash)?$/
  ])) {
    return text([
      '💰 O Arles Cash é seu assistente financeiro pelo WhatsApp.',
      'Você manda gastos, receitas e valores guardados; eu organizo, calculo saldo e preparo consultas e relatórios.',
      '',
      'Exemplo: “gastei 50 no mercado”.'
    ].join('\n'));
  }

  if (matches(value, [
    /^(como registrar|como registro|como lancar|como lanco|como anotar)( um)? (gasto|despesa|receita|lancamento)?$/,
    /^(como adiciono|como adicionar)( um)? (gasto|despesa|receita)?$/
  ])) {
    return text([
      '✍️ É só escrever naturalmente.',
      'Ex.: “gastei 50 no mercado” ou “recebi 800 de um cliente”.',
      'Antes de salvar, eu mostro o resumo e peço sua confirmação.'
    ].join('\n'));
  }

  if (matches(value, [
    /^(como vejo|como ver|como consulto|como consultar)( meu| o)? saldo$/,
    /^(como saber|como vejo) quanto tenho$/
  ])) {
    return text('📊 Para ver seu saldo, mande simplesmente *saldo*. Você também pode perguntar “quanto sobrou este mês?”.');
  }

  if (matches(value, [
    /^(quando recebo|quando chegam|quando envia|quando manda)( os)? relatorios$/,
    /^(quando sao|qual horario dos|qual o horario dos) relatorios$/,
    /^(relatorios automaticos|agenda de relatorios)$/
  ])) {
    return text([
      '📅 Relatórios automáticos:',
      '• Segunda-feira, 8h → resumo da semana anterior',
      '• Dia 1, 8h → resumo do mês anterior',
      '',
      'Você também pode pedir “relatório semanal” ou “relatório mensal” quando quiser.'
    ].join('\n'));
  }

  if (matches(value, [
    /^(o que e|oq e|que e) reserva$/,
    /^(o que significa) reserva$/
  ])) {
    return text('🏦 Reserva é dinheiro que você separou/guardou. Eu registro separado das despesas comuns para você enxergar quanto está poupando.');
  }

  return null;
}
