import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../../config/env.js';

const ImportedService=z.object({
  category:z.string(),equipment_type:z.string(),brand:z.string(),model_pattern:z.string(),name:z.string(),description:z.string(),
  pricing_mode:z.enum(['exact','range','diagnosis']),price_min:z.number().nullable(),price_max:z.number().nullable(),requires_diagnosis:z.boolean()
});
const ImportSchema=z.object({services:z.array(ImportedService),warnings:z.array(z.string())});
export type AssistImportResult=z.infer<typeof ImportSchema>;

export class AssistImportService{
  private client:OpenAI|null;
  constructor(){this.client=env.openaiApiKey?new OpenAI({apiKey:env.openaiApiKey}):null;}

  async parse(text:string):Promise<AssistImportResult>{
    if(!this.client)throw new Error('AI_NOT_CONFIGURED');
    const source=String(text??'').trim();
    if(source.length<10)throw new Error('IMPORT_TEXT_REQUIRED');
    const response=await this.client.responses.parse({
      model:env.openaiModel,
      input:[
        {role:'system',content:[
          'Converta informações comerciais de uma assistência técnica brasileira em uma base estruturada de serviços.',
          'Não invente preços, marcas, modelos ou serviços que não estejam no texto.',
          'Preço único: pricing_mode=exact e price_min=price_max. Expressões “a partir de”: pricing_mode=range, price_min informado e price_max=null.',
          'Quando o texto disser que depende de avaliação/diagnóstico: pricing_mode=diagnosis e preços null.',
          'Se houver ambiguidade importante, preserve o serviço de forma genérica e descreva a dúvida em warnings.',
          'model_pattern pode conter um modelo específico ou padrão textual; deixe vazio se não existir.',
          'description deve conter apenas condições úteis presentes na fonte, como diagnóstico gratuito se aprovar o reparo.'
        ].join('\n')},
        {role:'user',content:source}
      ],
      text:{format:zodTextFormat(ImportSchema,'assist_import')}
    });
    return response.output_parsed??{services:[],warnings:['A IA não retornou serviços estruturados.']};
  }
}
export const assistImportService=new AssistImportService();
