import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashPaymentMenuForCompany } from './checkout.js';
import { handleCashReportContext } from './report-context.js';
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
    'Nesse período você pode registrar, consultar saldo e usar os relatórios normalmente.'
  ];

  if (state.subscription_status === 'trial' && state.trial_ends_at) {
    const remainingMs = state.trial_ends_at.getTime() - Date.now();
    const days = Math.max(0, Math.ceil(remainingMs / 86_400_000));
    lines.push('', `O seu está ativo até ${formatBrazilDate(state.trial_ends_at)} — faltam ${days} dia${days === 1 ? '' : 's'}.`);
  } else if (state.subscription_status === 'active') {
    lines.push('', 'No seu caso, você já está com um plano ativo ✅');
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

  // Relatórios e continuidades temporais precisam ser resolvidos antes da IA.
  // Ex.: “me manda o resumo da semana” → “da semana passada”.
  const contextualReport = await handleCashReportContext(context);
  if (contextualReport) return contextualReport;

  // Trial e período gratuito.
  if (matches(value, [
    /^(o que e|oq e|que e|o que significa) (o )?trial$/,
    /^(como funciona|como funciona o) (trial|teste gratis|periodo gratuito)$/,
    /^(trial|teste gratis|periodo gratuito)$/,
    /^(quanto tempo dura|quantos dias dura)( o)? (trial|teste gratis)$/
  ])) {
    return await trialAnswer(context.company.id);
  }

  // Preço, planos e assinatura. Responde diretamente com os links personalizados.
  if (matches(value, [
    /^(quanto custa|qual o valor|quais os valores|preco|precos|planos|quais os planos)$/,
    /^(quanto custa o arles cash|qual o preco do arles cash|quais os planos do arles cash|como assino|como pagar|quero assinar|quero pagar)$/,
    /^(tem plano mensal|tem plano trimestral|tem plano anual)$/
  ])) {
    return await plansAnswer(context.company.id);
  }

  if (matches(value, [
    /^(qual o melhor plano|qual plano vale mais a pena|qual plano compensa mais|qual voce recomenda|qual plano voce recomenda)$/
  ])) {
    return text([
      '🏆 O Anual tem o menor custo por mês.',
      'São R$39,90 por 12 meses — equivalente a R$3,33/mês.',
      'No mensal, 12 meses sairiam por R$60,00.',
      '',
      'Se quiser, mande *planos* para eu gerar os links de pagamento.'
    ].join('\n'));
  }

  // O que é / como funciona.
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
    /^(preciso instalar|tem aplicativo|tem app|precisa baixar|preciso baixar)( alguma coisa| um app)?$/,
    /^(funciona so no whatsapp|funciona pelo whatsapp)$/
  ])) {
    return text('📱 Não precisa instalar nada. O Arles Cash funciona direto por aqui no WhatsApp.');
  }

  // Registrar: lançamento válido é salvo diretamente, sem etapa extra de confirmação.
  if (matches(value, [
    /^(como registrar|como registro|como lancar|como lanco|como anotar)( um)? (gasto|despesa|receita|lancamento)?$/,
    /^(como adiciono|como adicionar)( um)? (gasto|despesa|receita)?$/
  ])) {
    return text([
      '✍️ É só escrever naturalmente.',
      'Ex.: “gastei 50 no mercado” ou “recebi 800 de um cliente”.',
      'Quando os dados estiverem completos, eu registro automaticamente e te aviso na hora.'
    ].join('\n'));
  }

  if (matches(value, [
    /^(por que confirma|porque confirma|precisa confirmar|por que pede confirmacao|como funciona a confirmacao)$/
  ])) {
    return text('✅ Não precisa mais confirmar cada lançamento. Se os dados estiverem completos, eu registro na hora. Se faltar algo essencial, como o valor, eu pergunto antes.');
  }

  // Consultas e histórico.
  if (matches(value, [
    /^(como vejo|como ver|como consulto|como consultar)( meu| o)? saldo$/,
    /^(como saber|como vejo) quanto tenho$/
  ])) {
    return text('📊 Para ver seu saldo, mande simplesmente *saldo*. Você também pode perguntar “quanto sobrou este mês?”.');
  }

  if (matches(value, [
    /^(como vejo|como ver|como consulto|como consultar)( meus| os)? (gastos|registros|lancamentos|despesas)$/,
    /^(como vejo meu historico|como ver historico)$/
  ])) {
    return text('🔎 Pode pedir naturalmente: “o que gastei hoje?”, “meus gastos deste mês” ou simplesmente *histórico*.');
  }

  // Edição e exclusão.
  if (matches(value, [
    /^(como editar|como corrijo|como corrigir|como altero|como alterar)( um)? (registro|lancamento|gasto)?$/
  ])) {
    return text('✏️ Diga “edita o último” ou “edita o 2”. Depois me fale o que mudou, por exemplo: “o valor foi 35 reais”.');
  }

  if (matches(value, [
    /^(como apagar|como excluir|como remover)( um)? (registro|lancamento|gasto)?$/
  ])) {
    return text('🗑️ Diga “apaga o último” ou “remove o 2”. Se apagar por engano, você também pode pedir para desfazer.');
  }

  // Relatórios.
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

  // Categorias e reserva.
  if (matches(value, [
    /^(quais categorias|quais sao as categorias|que categorias existem|como funciona as categorias|como funcionam as categorias)$/
  ])) {
    return text([
      '📂 Eu organizo automaticamente em:',
      'Alimentação, Transporte, Saúde, Moradia, Educação, Pessoal, Reserva, Receita e Outros.',
      '',
      'Você não precisa escolher a categoria ao registrar.'
    ].join('\n'));
  }

  if (matches(value, [
    /^(o que e|oq e|que e) reserva$/,
    /^(o que significa) reserva$/
  ])) {
    return text('🏦 Reserva é dinheiro que você separou ou guardou. Eu deixo isso separado das despesas comuns para você enxergar quanto está poupando.');
  }

  // Pagamento e acesso, sem expor o provedor utilizado por trás.
  if (matches(value, [
    /^(quando libera|quando meu acesso libera|quanto tempo para liberar|quanto tempo demora para liberar)( depois do pagamento)?$/,
    /^(paguei e agora|depois que eu pagar o que acontece)$/
  ])) {
    return text('✅ Assim que o pagamento for confirmado, seu acesso é ativado automaticamente e você recebe a confirmação aqui no WhatsApp.');
  }

  if (matches(value, [
    /^(meus dados somem|perco meus dados|o que acontece com meus dados quando acaba o trial|meus registros ficam salvos)$/
  ])) {
    return text('🔒 Seus registros continuam salvos mesmo quando o trial ou o período pago termina. Ao reativar o acesso, você continua de onde parou.');
  }

  if (matches(value, [
    /^(posso cancelar|como cancelo|como cancelar assinatura|quero cancelar)$/
  ])) {
    return text('📌 Ao cancelar, o acesso continua disponível até o fim do período já pago. Seus registros permanecem salvos.');
  }

  return null;
}
