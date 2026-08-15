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
  order_action: z.enum(['', 'replace', 'add', 'remove', 'keep']),
  product_requests: z.array(ProductRequestSchema),
  unrecognized_products: z.array(z.string()),
  delivery_type: z.enum(['delivery', 'pickup', '']),
  payment_method: z.enum(['pix', 'cash', 'card', '']),
  customer_name: z.string(),
  address: z.string(),
  change_for: z.number().nullable(),
  observation: z.string()
});

export type DeliveryIntent = z.infer<typeof DeliveryIntentSchema>;

const emptyIntent: DeliveryIntent = {
  intent: 'unknown',
  order_action: '',
  product_requests: [],
  unrecognized_products: [],
  delivery_type: '',
  payment_method: '',
  customer_name: '',
  address: '',
  change_for: null,
  observation: ''
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
    draftItems?: string[];
    recentHistory?: Array<{ direction: string; body: string }>;
  }): Promise<DeliveryIntent> {
    if (!this.client) return emptyIntent;

    const catalogText = input.catalog.map(product => {
      const variations = product.variations?.map(v => v.name).filter(Boolean).join(', ');
      return variations ? `${product.name} [variações: ${variations}]` : product.name;
    }).join(' | ');

    const historyText = (input.recentHistory ?? [])
      .slice(-8)
      .map(item => `${item.direction === 'in' ? 'Cliente' : 'Atendente'}: ${item.body}`)
      .join('\n');

    try {
      const response = await this.client.responses.parse({
        model: env.openaiModel,
        input: [
          {
            role: 'system',
            content: [
              'Você é a camada semântica do Arles Delivery e interpreta mensagens de clientes de delivery brasileiro.',
              'Seu objetivo é ajudar o sistema a FECHAR O PEDIDO sozinho. Nunca decida transferir a conversa para humano/equipe.',
              'Não invente produtos, preços, sabores, variações ou informações. Produto e preço sempre vêm do catálogo real.',
              'Classifique como order quando houver intenção real de pedir, adicionar, remover, trocar ou corrigir itens.',
              'Perguntas de preço, disponibilidade, ingredientes, prazo, taxa ou funcionamento são question.',
              'product_requests.query deve usar o nome canônico do catálogo somente quando a correspondência for segura.',
              'Se o cliente mencionar algo que não corresponde com segurança a um produto do catálogo, não force a correspondência: coloque o termo em unrecognized_products.',
              'variation só pode conter uma variação claramente dita pelo cliente.',
              'notes contém observações do item como sem cebola, tirar molho, bem passado etc.',
              'order_action=replace quando o cliente estiver corrigindo o conjunto de itens e disser o que quer no lugar do resumo anterior.',
              'order_action=add quando ele disser explicitamente para adicionar/acrescentar/manter os atuais e colocar mais itens.',
              'order_action=remove quando ele pedir explicitamente para retirar itens.',
              'order_action=keep somente quando ele disser claramente que os itens atuais estão certos e não quer mudá-los.',
              'Quando o cliente usar referência como “só aquela que mandei”, “o que eu falei antes” ou semelhante, use o contexto recente apenas se a referência estiver clara. Nesse caso, resolva os produtos referidos em product_requests e use order_action=replace quando for uma correção.',
              'Pedido explícito de atendente, reclamação ou cancelamento pode ser classificado no intent correspondente, mas NÃO existe handoff automático: o Arles continua atendendo.',
              'Se um campo não foi informado, retorne string vazia/null/array vazio.',
              `Campo/estado que o sistema espera agora: ${input.expectedField ?? 'nenhum'}.`,
              `Há pedido em andamento: ${input.hasDraft ? 'sim' : 'não'}.`,
              `Itens atuais do rascunho: ${(input.draftItems ?? []).join(' | ') || 'nenhum'}.`,
              `Há pedido recém-confirmado: ${input.hasRecentConfirmedOrder ? 'sim' : 'não'}.`,
              `Produtos conhecidos: ${catalogText}`,
              historyText ? `Contexto recente:\n${historyText}` : ''
            ].filter(Boolean).join('\n')
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
