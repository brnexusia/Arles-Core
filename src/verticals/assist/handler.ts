import type { VerticalContext, VerticalResult } from '../vertical.js';
import { assistService } from './service.js';
import { assistTriageService } from './ai/triage.service.js';

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const brl = (n: number) => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(n);

function fallback(text: string) {
  const t = norm(text);
  return {
    intent: /\b(preco|valor|quanto|orcamento)\b/.test(t) ? 'quote' : /\b(consert|arrum|reparo|quebrou|parou|defeito)\b/.test(t) ? 'repair' : /\b(status|pronto|ficou pronto|meu aparelho|minha ordem)\b/.test(t) ? 'status' : /\b(oi|ola|bom dia|boa tarde|boa noite)\b/.test(t) ? 'greeting' : 'unknown',
    equipment_type: '', brand: '', model: '', problem: text, customer_name: '', wants_pickup: false, approval: 'unknown', confidence: .25
  } as const;
}

function shortDecision(text: string): 'yes' | 'no' | null {
  const t = norm(text).replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
  if (t.length > 40) return null;
  if (/^(sim|sim por favor|pode|pode sim|confirmo|quero|fechado|vamos|isso|isso mesmo|ok|certo|beleza)$/.test(t)) return 'yes';
  if (/^(nao|nao quero|deixa|deixa pra la|cancelar|cancela|agora nao)$/.test(t)) return 'no';
  return null;
}

export class AssistHandler {
  async handle({ company, message, combinedText }: VerticalContext): Promise<VerticalResult | null> {
    const catalog = await assistService.services(company.id);
    const extracted = await assistTriageService.extract(combinedText, catalog as any[]);
    const intent = extracted.confidence > 0 ? extracted : fallback(combinedText);
    const text = norm(combinedText);
    const decision = shortDecision(combinedText);
    const existing = await assistService.latestForPhone(company.id, message.phone);

    if (intent.intent === 'status') {
      if (!existing) return { actions: [{ type:'text', text:'Não encontrei uma ordem de serviço nesse número. Se quiser, me diga qual aparelho está com problema e eu começo um atendimento agora.' }] };
      const labels: Record<string,string> = {
        triage:'em triagem', quoted:'com orçamento preparado', awaiting_approval:'aguardando sua aprovação', confirmed:'orçamento confirmado', received:'recebido na assistência',
        diagnosis:'em diagnóstico', approved:'serviço aprovado', repairing:'em reparo', ready:'pronto para retirada/entrega', delivered:'entregue', cancelled:'cancelado'
      };
      return { actions: [{ type:'text', text:`Encontrei sua OS para ${[existing.brand,existing.model,existing.equipment_type].filter(Boolean).join(' ') || 'o aparelho'}. O status atual é: *${labels[existing.status] || existing.status}*.${existing.promised_at ? `\nPrevisão: ${new Date(existing.promised_at).toLocaleString('pt-BR')}.` : ''}` }] };
    }

    const waitingForDecision = existing && ['quoted','awaiting_approval'].includes(existing.status);
    const approval = intent.approval !== 'unknown' ? intent.approval : decision;
    if (waitingForDecision && approval === 'yes') {
      const exactQuote = existing.quoted_min != null && existing.quoted_max != null && Number(existing.quoted_min) === Number(existing.quoted_max);
      await assistService.updateOrder(company.id, existing.id, {
        status: 'confirmed',
        approved_price: exactQuote ? Number(existing.quoted_min) : null,
        note: 'Orçamento confirmado pelo cliente no atendimento automático.'
      });
      return { actions: [{ type:'text', text:`Perfeito! ✅ Deixei sua OS *confirmada* para ${[existing.brand,existing.model,existing.equipment_type].filter(Boolean).join(' ') || 'o aparelho'}.${exactQuote ? ` O valor confirmado é ${brl(Number(existing.quoted_min))}.` : ''}\n\nAgora é só trazer o aparelho para a assistência${(await assistService.settings(company.id) as any).pickup_enabled ? ' ou solicitar a retirada' : ''}.` }] };
    }
    if (waitingForDecision && approval === 'no') {
      await assistService.updateOrder(company.id, existing.id, { status:'cancelled', note:'Orçamento recusado/cancelado pelo cliente.' });
      return { actions: [{ type:'text', text:'Sem problema. Deixei esse orçamento como não confirmado. Se quiser consultar outro reparo ou aparelho, é só me falar.' }] };
    }

    if (intent.intent === 'greeting' || (intent.intent === 'unknown' && /^\s*(oi|ola|opa|eai|e ai)\b/.test(text))) {
      const equipment = [...new Set((catalog as any[]).filter(s => s.active).map(s => s.equipment_type))].slice(0,8);
      return { actions: [{ type:'text', text: equipment.length
        ? `Olá, ${message.pushName || 'tudo bem'}! 👋 Posso te ajudar com orçamento e conserto. Atendemos ${equipment.join(', ')}.\n\nQual aparelho você tem e o que aconteceu com ele?`
        : `Olá, ${message.pushName || 'tudo bem'}! 👋 Posso te ajudar com seu reparo. Qual aparelho você tem e o que aconteceu com ele?` }] };
    }

    if (!catalog.length) {
      await assistService.upsertConversationOrder({
        companyId: company.id, phone: message.phone, name: intent.customer_name || message.pushName || 'Cliente', messageId: message.messageId,
        equipment: intent.equipment_type, brand: intent.brand, model: intent.model, problem: intent.problem || combinedText
      });
      return { actions: [{ type:'text', text:'Já registrei seu atendimento. Nossa tabela de serviços ainda está sendo configurada, então não vou inventar um valor. Me diga o modelo do aparelho e o defeito apresentado; a equipe recebe essas informações para continuar o orçamento.' }] };
    }

    const candidates = await assistService.findCandidates(company.id, {
      equipment: intent.equipment_type, brand: intent.brand, model: intent.model, problem: intent.problem || combinedText
    });
    const service = (candidates as any[])[0];
    const order = await assistService.upsertConversationOrder({
      companyId: company.id, phone: message.phone, name: intent.customer_name || message.pushName || 'Cliente', messageId: message.messageId,
      equipment: intent.equipment_type, brand: intent.brand, model: intent.model, problem: intent.problem || combinedText, service
    });

    if (!intent.equipment_type && !service) {
      return { actions: [{ type:'text', text:'Consigo montar o orçamento para você. Primeiro me diga qual é o aparelho — por exemplo iPhone, Samsung, notebook, TV — e, se souber, o modelo.' }] };
    }
    if (!intent.model && service?.model_pattern) {
      return { actions: [{ type:'text', text:`Entendi. Para eu não te passar um valor errado, qual é o modelo exato do ${intent.equipment_type || service.equipment_type}?` }] };
    }
    if (!service) {
      return { actions: [{ type:'text', text:`Já registrei seu atendimento para ${[intent.brand,intent.model,intent.equipment_type].filter(Boolean).join(' ') || 'o aparelho'}. Pelo que você descreveu, preciso de uma avaliação antes de confirmar o valor. ${intent.problem ? 'O defeito relatado ficou registrado.' : 'Me conte o que o aparelho está apresentando.'}` }] };
    }
    if (service.pricing_mode === 'exact' && service.price_min != null && !service.requires_diagnosis) {
      await assistService.updateOrder(company.id, String((order as any).id), { status:'awaiting_approval', note:'Orçamento exato apresentado pela IA.' });
      return { actions: [{ type:'text', text:`Para ${service.name}${intent.model ? ` no ${intent.model}` : ''}, o valor cadastrado é *${brl(Number(service.price_min))}*.\n\nQuer que eu já deixe a ordem de serviço confirmada para você trazer o aparelho?` }] };
    }
    if (service.pricing_mode === 'range' && service.price_min != null && !service.requires_diagnosis) {
      const range = service.price_max != null ? `${brl(Number(service.price_min))} a ${brl(Number(service.price_max))}` : `a partir de ${brl(Number(service.price_min))}`;
      await assistService.updateOrder(company.id, String((order as any).id), { status:'awaiting_approval', note:'Faixa de orçamento apresentada pela IA.' });
      return { actions: [{ type:'text', text:`Para ${service.name}${intent.model ? ` no ${intent.model}` : ''}, o orçamento cadastrado fica *${range}*. O valor final pode depender da avaliação do aparelho.\n\nQuer seguir e deixar a OS confirmada?` }] };
    }

    const settings = await assistService.settings(company.id);
    const fee = Number((settings as any).diagnosis_fee || 0);
    return { actions: [{ type:'text', text:`Esse serviço precisa de diagnóstico antes de fechar o valor.${fee > 0 ? ` A avaliação custa ${brl(fee)}${(settings as any).diagnosis_waived_if_approved ? ', e esse valor é abatido/dispensado se o serviço for aprovado' : ''}.` : ''}\n\nPosso deixar a entrada do aparelho encaminhada agora.` }] };
  }
}

export const assistHandler = new AssistHandler();
