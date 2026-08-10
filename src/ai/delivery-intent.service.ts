import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../config/env.js';

const ProductRequestSchema = z.object({
  query: z.string(),
  quantity: z.number().int().min(1).max(50),
  notes: z.string()
});

const DeliveryIntentSchema = z.object({
  intent: z.enum([
    'greeting',
    'menu',
    'order',
    'question',
    'human',
    'unknown'
  ]),
  product_requests: z.array(ProductRequestSchema),
  delivery_type: z.enum(['delivery', 'pickup', '']),
  payment_method: z.enum(['pix', 'cash', 'card', '']),
  customer_name: z.string(),
  address: z.string(),
  change_for: z.number().nullable()
});

export type DeliveryIntent = z.infer<typeof DeliveryIntentSchema>;

const emptyIntent: DeliveryIntent = {
  intent: 'unknown',
  product_requests: [],
  delivery_type: '',
  payment_method: '',
  customer_name: '',
  address: '',
  change_for: null
};

export class DeliveryIntentService {
  private client: OpenAI | null;

  constructor() {
    this.client = env.openaiApiKey
      ? new OpenAI({ apiKey: env.openaiApiKey })
      : null;
  }

  async extract(input: {
    message: string;
    expectedField: string | null;
    catalogNames: string[];
  }): Promise<DeliveryIntent> {
    if (!this.client) return emptyIntent;

    const response = await this.client.responses.parse({
      model: env.openaiModel,
      input: [
        {
          role: 'system',
          content: [
            'Você extrai intenção de mensagens de clientes de um delivery.',
            'Não invente produtos, preços ou dados.',
            'product_requests.query deve refletir somente o que o cliente escreveu.',
            'Se um campo não foi informado, retorne string vazia/null.',
            `Campo que o sistema está esperando: ${input.expectedField ?? 'nenhum'}.`,
            `Produtos conhecidos: ${input.catalogNames.join(' | ')}`
          ].join('\n')
        },
        {
          role: 'user',
          content: input.message
        }
      ],
      text: {
        format: zodTextFormat(DeliveryIntentSchema, 'delivery_intent')
      }
    });

    return response.output_parsed ?? emptyIntent;
  }
}

export const deliveryIntentService = new DeliveryIntentService();
