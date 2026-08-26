import type { VerticalContext, VerticalResult } from '../vertical.js';
import { assistService } from './service.js';
import { assistTriageService } from './ai/triage.service.js';

const norm=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const brl=(n:number)=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(n);

function fallback(text:string){
  const t=norm(text);
  return {
    intent:/\b(preco|valor|quanto|orcamento|orcamento)\b/.test(t)?'quote':/\b(consert|arrum|reparo|quebrou|parou|defeito)\b/.test(t)?'repair':/\b(status|pronto|ficou pronto|meu aparelho|minha ordem)\b/.test(t)?'status':/\b(oi|ola|bom dia|boa tarde|boa noite)\b/.test(t)?'greeting':'unknown',
    equipment_type:'',brand:'',model:'',problem:text,customer_name:'',wants_pickup:false,approval:'unknown',confidence:.25
  } as const;
}

export class AssistHandler{
  async handle({company,message,combinedText}:VerticalContext):Promise<VerticalResult|null>{
    const catalog=await assistService.services(company.id);
    if(!catalog.length){
      return {actions:[{type:'text',text:'Olá! Nossa tabela de serviços ainda está sendo configurada. Me diga qual aparelho você precisa consertar e qual problema ele apresenta; vou registrar para a equipe continuar o atendimento.'}]};
    }

    const extracted=await assistTriageService.extract(combinedText,catalog as any[]);
    const intent=extracted.confidence>0?extracted:fallback(combinedText);
    const text=norm(combinedText);

    if(intent.intent==='greeting' || (intent.intent==='unknown'&&/^\s*(oi|ola|opa|eai|e ai)\b/.test(text))){
      const equipment=[...new Set((catalog as any[]).filter(s=>s.active).map(s=>s.equipment_type))].slice(0,8);
      return {actions:[{type:'text',text:`Olá, ${message.pushName||'tudo bem'}! 👋 Posso te ajudar com orçamento e conserto. Atendemos ${equipment.join(', ')}.\n\nQual aparelho você tem e o que aconteceu com ele?`}]};
    }

    if(intent.intent==='status'){
      const order=await assistService.latestForPhone(company.id,message.phone);
      if(!order)return {actions:[{type:'text',text:'Não encontrei uma ordem de serviço aberta nesse número. Se quiser, me diga qual aparelho está com problema e eu começo um atendimento agora.'}]};
      const labels:Record<string,string>={triage:'em triagem',quoted:'com orçamento enviado',awaiting_approval:'aguardando sua aprovação',received:'recebido na assistência',diagnosis:'em diagnóstico',approved:'aprovado',repairing:'em reparo',ready:'pronto para retirada/entrega',delivered:'entregue',cancelled:'cancelado'};
      return {actions:[{type:'text',text:`Encontrei sua OS para ${[order.brand,order.model,order.equipment_type].filter(Boolean).join(' ')||'o aparelho'}. O status atual é: *${labels[order.status]||order.status}*.${order.promised_at?`\nPrevisão: ${new Date(order.promised_at).toLocaleString('pt-BR')}.`:''}`}]};
    }

    const candidates=await assistService.findCandidates(company.id,{equipment:intent.equipment_type,brand:intent.brand,model:intent.model,problem:intent.problem||combinedText});
    const service=(candidates as any[])[0];
    await assistService.upsertConversationOrder({companyId:company.id,phone:message.phone,name:intent.customer_name||message.pushName||'Cliente',messageId:message.messageId,
      equipment:intent.equipment_type,brand:intent.brand,model:intent.model,problem:intent.problem||combinedText,service});

    if(!intent.equipment_type && !service){
      return {actions:[{type:'text',text:'Consigo montar o orçamento para você. Primeiro me diga qual é o aparelho — por exemplo iPhone, Samsung, notebook, TV — e, se souber, o modelo.'}]};
    }
    if(!intent.model && service?.model_pattern){
      return {actions:[{type:'text',text:`Entendi. Para eu não te passar um valor errado, qual é o modelo exato do ${intent.equipment_type||service.equipment_type}?`}]};
    }
    if(!service){
      return {actions:[{type:'text',text:`Já registrei seu atendimento para ${[intent.brand,intent.model,intent.equipment_type].filter(Boolean).join(' ')||'o aparelho'}. Pelo que você descreveu, preciso de uma avaliação antes de confirmar o valor. ${intent.problem?'O defeito relatado ficou registrado.':'Me conte o que o aparelho está apresentando.'}`}]};
    }
    if(service.pricing_mode==='exact' && service.price_min!=null && !service.requires_diagnosis){
      return {actions:[{type:'text',text:`Para ${service.name}${intent.model?` no ${intent.model}`:''}, o valor cadastrado é *${brl(Number(service.price_min))}*.\n\nQuer que eu já deixe a ordem de serviço aberta para você trazer o aparelho?`}]};
    }
    if(service.pricing_mode==='range' && service.price_min!=null && !service.requires_diagnosis){
      const range=service.price_max!=null?`${brl(Number(service.price_min))} a ${brl(Number(service.price_max))}`:`a partir de ${brl(Number(service.price_min))}`;
      return {actions:[{type:'text',text:`Para ${service.name}${intent.model?` no ${intent.model}`:''}, o orçamento cadastrado fica *${range}*. O valor final depende da avaliação do aparelho.\n\nQuer seguir e abrir a OS?`}]};
    }

    const settings=await assistService.settings(company.id);
    const fee=Number((settings as any).diagnosis_fee||0);
    return {actions:[{type:'text',text:`Esse serviço precisa de diagnóstico antes de fechar o valor.${fee>0?` A avaliação custa ${brl(fee)}${(settings as any).diagnosis_waived_if_approved?', e esse valor é abatido/dispensado se o serviço for aprovado':''}.`:''}\n\nPosso deixar a entrada do aparelho encaminhada agora.`}]};
  }
}
export const assistHandler=new AssistHandler();
