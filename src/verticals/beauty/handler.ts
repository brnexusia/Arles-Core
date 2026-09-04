import type { VerticalContext, VerticalResult } from '../vertical.js';
import { reserveBeautyAiBudget, recordBeautyAiFailure, recordBeautyAiSuccess } from '../../security/ai-budget.js';
import { beautyFeatureEnabled } from '../../security/kill-switches.js';
import { beautyService } from './service.js';
import { beautyAiService } from './ai.service.js';

const norm=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const brl=(n:number)=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(n);

export class BeautyHandler {
  async handle(context:VerticalContext):Promise<VerticalResult|null>{
    // Global emergency stop is silent on WhatsApp: no outbound is generated.
    if (!beautyFeatureEnabled('global')) return null;

    if (beautyFeatureEnabled('ai')) {
      let release: (()=>Promise<void>) | null = null;
      try {
        release = await reserveBeautyAiBudget(context.company.id, context.message.phone);
        const aiResult = await beautyAiService.handle(context);
        if (aiResult) {
          await recordBeautyAiSuccess(context.company.id);
          return aiResult;
        }
        await recordBeautyAiFailure(context.company.id);
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error);
        if (!/^(RATE_LIMITED|BEAUTY_AI_BUSY|BEAUTY_AI_CIRCUIT_OPEN)$/.test(code)) throw error;
      } finally {
        if (release) await release();
      }
    }

    // When only AI is disabled/budget-limited, retain a grounded no-OpenAI fallback.
    const {company,combinedText}=context;
    const text=norm(combinedText);
    const services=await beautyService.services(company.id);
    const professionals=await beautyService.professionals(company.id);
    if(!services.length){return {actions:[{type:'text',text:'Olá! Nossa agenda está sendo configurada. Tente novamente em instantes, por favor. 😊'}]};}
    const service=services.find((s:any)=>text.includes(norm(s.name)));
    if(/\b(oi|ola|bom dia|boa tarde|boa noite|servico|servicos|valor|preco|agenda|agendar|horario)\b/.test(text)&&!service){
      const list=services.filter((s:any)=>s.active).map((s:any)=>`• ${s.name} — ${brl(Number(s.price))} · ${s.duration_minutes} min`).join('\n');
      return {actions:[{type:'text',text:`Olá! 💜 Estes são nossos serviços:\n\n${list}\n\nQual você gostaria de agendar?`}]};
    }
    if(service){
      const available=professionals.filter((p:any)=>p.active&&p.service_ids?.includes(service.id));
      const names=available.map((p:any)=>p.name).join(', ');
      return {actions:[{type:'text',text:`Perfeito! ${service.name} dura cerca de ${service.duration_minutes} minutos e custa ${brl(Number(service.price))}.${names?` Temos ${names}.`:''}\n\nQual dia você prefere?`}]};
    }
    return {actions:[{type:'text',text:'Posso ajudar com serviços, valores e agendamentos. Qual serviço você quer fazer? 😊'}]};
  }
}
export const beautyHandler=new BeautyHandler();
