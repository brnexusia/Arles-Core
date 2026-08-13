import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../../config/env.js';

const ProductRequestSchema = z.object({
  query: z.string(),
  quantity: z.number().int().min(1).max(50),
  variation: z.string(),
  notes: z.string()
});

const DeliveryIntentSchema = z.object({
  intent: z.enum(['greeting', 'menu', 'order', 'question', 'human', 'complaint', 'cancel', 'unknown']),
  product_requests: z.array(ProductRequestSchema),
  delivery_type: z.enum(['delivery', 'pickup', '']),
  payment_method: z.enum(['pix', 'cash', 'card', '']),
  customer_name: z.string(),
  address: z.string(),
  change_for: z.number().nullable(),
  observation: z.string(),
  handoff: z.boolean(),
  handoff_reason: z.string()
});

export type DeliveryIntent = z.infer<typeof DeliveryIntentSchema>;

const emptyIntent: DeliveryIntent = {
  intent: 'unknown',
  product_requests: [],
  delivery_type: '',
  payment_method: '',
  customer_name: '',
  address: '',
  change_for: null,
  observation: '',
  handoff: false,
  handoff_reason: ''
};

export class DeliveryIntentService {
  private client: OpenAI | null;

  constructor() {
    this.client = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;
  }

  async extract(input: {
    message: string;
    expectedField: string | null;
    catalog: Array<{ name: string; variations?: Array<{ name: string }> }>;
    hasDraft: boolean;
    hasRecentConfirmedOrder: boolean;
  }): Promise<DeliveryIntent> {
    if (!this.client) return emptyIntent;

    const catalogText = input.catalog.map(product => {
      const variations = product.variations?.map(v => v.name).filter(Boolean).join(', ');
      return variations ? `${product.name} [variações: ${variations}]` : product.name;
    }).join(' | ');

    try {
      const response = await this.client.responses.parse({
        model: env.openaiModel,
        input: [
          {
            role: 'system',
            content: [
              'Você extrai intenção e dados de mensagens de clientes de um delivery brasileiro.',
              'Não invente produtos, preços, sabores, variações ou informações.',
              'Classifique como order apenas quando houver intenção real de pedir/adicionar/remover/alterar item; perguntas de preço ou disponibilidade são question.',
              'product_requests.query deve conter apenas o produto que a pessoa realmente mencionou ou pediu.',
              'variation só pode conter uma variação claramente dita pelo cliente.',
              'notes contém observações do item como sem cebola, bem passado, tirar molho etc.',
              'handoff=true para pedido explícito de humano, reclamação, atraso, cancelamento ou alteração de pedido já confirmado.',
              'Se um campo não foi informado, retorne string vazia/null.',
              `Campo que o sistema espera agora: ${input.expectedField ?? 'nenhum'}.`,
              `Há pedido em andamento: ${input.hasDraft ? 'sim' : 'não'}.`,
              `Há pedido recém-confirmado: ${input.hasRecentConfirmedOrder ? 'sim' : 'não'}.`,
              `Produtos conhecidos: ${catalogText}`
            ].join('\n')
          },
          { role: 'user', content: input.message }
        ],
        text: { format: zodTextFormat(DeliveryIntentSchema, 'delivery_intent') }
      });

      return response.output_parsed ?? emptyIntent;
    } catch (error) {
      console.error('[DeliveryIntent] falha na IA; usando parser determinístico:', error);
      return emptyIntent;
    }
  }
}

export const deliveryIntentService = new DeliveryIntentService();
