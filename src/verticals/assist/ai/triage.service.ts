import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../../config/env.js';

const AssistIntentSchema=z.object({
  intent:z.enum(['greeting','quote','repair','status','approval','human','question','unknown']),
  equipment_type:z.string(),
  brand:z.string(),
  model:z.string(),
  problem:z.string(),
  customer_name:z.string(),
  wants_pickup:z.boolean(),
  approval:z.enum(['yes','no','unknown']),
  confidence:z.number().min(0).max(1)
});
export type AssistIntent=z.infer<typeof AssistIntentSchema>;
const empty:AssistIntent={intent:'unknown',equipment_type:'',brand:'',model:'',problem:'',customer_name:'',wants_pickup:false,approval:'unknown',confidence:0};

export class AssistTriageService{
  private client:OpenAI|null;
  constructor(){this.client=env.openaiApiKey?new OpenAI({apiKey:env.openaiApiKey}):null;}

  async extract(message:string,catalog:Array<{equipment_type:string;brand?:string|null;model_pattern?:string|null;name:string}>):Promise<AssistIntent>{
    if(!this.client)return empty;
    const services=catalog.slice(0,120).map(s=>`${s.equipment_type} | ${s.brand??'*'} | ${s.model_pattern??'*'} | ${s.name}`).join('\n');
    try{
      const response=await this.client.responses.parse({
        model:env.openaiModel,
        input:[
          {role:'system',content:[
            'Você interpreta mensagens de clientes de uma assistência técnica brasileira.',
            'Extraia somente fatos ditos pelo cliente. Nunca invente modelo, defeito, preço ou serviço.',
            'quote = quer saber preço/orçamento; repair = quer consertar/abrir atendimento; status = pergunta por aparelho/OS em andamento; approval = aceita ou recusa um orçamento.',
            'problem deve resumir o sintoma relatado sem transformar em diagnóstico técnico definitivo.',
            'Se houver incerteza relevante, deixe o campo vazio e reduza confidence.',
            'Catálogo conhecido serve apenas como referência de nomes, nunca como licença para inventar correspondências.',
            `Catálogo:\n${services||'vazio'}`
          ].join('\n')},
          {role:'user',content:message}
        ],
        text:{format:zodTextFormat(AssistIntentSchema,'assist_intent')}
      });
      return response.output_parsed??empty;
    }catch(error){
      console.error('[AssistTriage] falha na IA; usando fallback determinístico:',error);
      return empty;
    }
  }
}
export const assistTriageService=new AssistTriageService();
