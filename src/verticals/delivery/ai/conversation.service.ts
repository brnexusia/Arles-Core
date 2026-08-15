import OpenAI from 'openai';
import { env } from '../../../config/env.js';
import type { DeliveryCustomer, DeliveryProduct, DeliveryStore } from '../types.js';

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
      return 'Não entendi essa parte. Me explica de outro jeito que eu continuo seu pedido 😊';
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
              'Você é a atendente virtual do Arles Delivery no WhatsApp.',
              'Seu papel é conduzir a conversa até o pedido ser fechado pelo próprio Arles.',
              'Responda em português brasileiro, natural, curto e simpático.',
              'Use no máximo um emoji. Faça no máximo uma pergunta por resposta.',
              'Nunca diga que vai chamar, transferir, encaminhar ou deixar a equipe/humano continuar. O Arles deve continuar o atendimento sozinho.',
              'A única fonte de verdade são os dados abaixo. Nunca invente produto, preço, taxa, horário, prazo, bairro, promoção ou pagamento.',
              'Se faltar informação ou a fala estiver ambígua, faça uma pergunta objetiva para esclarecer e continuar o pedido.',
              'Se o cliente pedir algo que não existe claramente no catálogo, diga isso sem inventar equivalência e ofereça as opções reais mais próximas quando houver.',
              'Não exponha IDs, JSON, URLs internas ou detalhes técnicos.',
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

      return String(response.output_text ?? '').trim() || 'Me explica só essa parte de outro jeito que eu continuo seu pedido 😊';
    } catch (error) {
      console.error('[DeliveryConversation] falha na IA:', error);
      return 'Não consegui entender essa parte agora. Me explica de outro jeito que eu continuo seu pedido 😊';
    }
  }
}

export const deliveryConversationService = new DeliveryConversationService();
