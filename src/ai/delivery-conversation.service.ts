import OpenAI from 'openai';
import { env } from '../config/env.js';
import type { DeliveryCustomer, DeliveryProduct, DeliveryStore } from '../verticals/delivery/types.js';

export class DeliveryConversationService {
  private client: OpenAI | null;

  constructor() {
    this.client = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;
  }

  async answer(input: {
    message: string;
    store: DeliveryStore;
    customer: DeliveryCustomer | null;
    catalog: DeliveryProduct[];
    history: Array<{ direction: string; body: string }>;
    settings?: Record<string, unknown>;
  }): Promise<string> {
    if (!this.client) {
      return 'Posso te ajudar com o cardápio, valores, entrega e seu pedido 😊';
    }

    const catalog = input.catalog.map(product => ({
      name: product.name,
      category: product.category,
      description: product.description,
      price: product.price,
      variations: (product.variations ?? []).map(v => ({ name: v.name, price_delta: v.price_delta }))
    }));

    const history = input.history.slice(-10).map(item => `${item.direction === 'in' ? 'Cliente' : 'Atendente'}: ${item.body}`).join('\n');

    try {
      const response = await this.client.responses.create({
        model: env.openaiModel,
        input: [
          {
            role: 'system',
            content: [
              'Você é a atendente virtual de um delivery no WhatsApp.',
              'Responda em português brasileiro, natural, curto e simpático.',
              'Use no máximo um emoji. Faça no máximo uma pergunta.',
              'A única fonte de verdade são os dados abaixo. Nunca invente produto, preço, taxa, horário, prazo, bairro, promoção ou pagamento.',
              'Não exponha IDs, JSON, URLs internas ou detalhes técnicos.',
              'Se a informação não existir nos dados, diga que não consegue confirmar e ofereça ajuda da equipe.',
              `LOJA: ${JSON.stringify(input.store)}`,
              `CONFIGURAÇÕES: ${JSON.stringify(input.settings ?? {})}`,
              `CLIENTE: ${JSON.stringify(input.customer ?? {})}`,
              `CATÁLOGO: ${JSON.stringify(catalog)}`,
              history ? `CONTEXTO RECENTE:\n${history}` : ''
            ].filter(Boolean).join('\n\n')
          },
          { role: 'user', content: input.message }
        ]
      });

      return String(response.output_text ?? '').trim() || 'Como posso te ajudar? 😊';
    } catch (error) {
      console.error('[DeliveryConversation] falha na IA:', error);
      return 'Não consegui confirmar essa informação agora. Se quiser, posso te ajudar com o cardápio e o pedido 😊';
    }
  }
}

export const deliveryConversationService = new DeliveryConversationService();
