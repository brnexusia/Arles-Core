import { deliveryIntentService } from '../../ai/delivery-intent.service.js';
import {
  getRecentConfirmedOrder,
  markRecentConfirmedOrder
} from '../../infrastructure/redis.js';
import type { VerticalContext, VerticalHandler } from '../vertical.js';
import {
  brl,
  detectDeliveryType,
  detectPayment,
  emptyDraft,
  extractName,
  findProductsInMessage,
  isConfirmation,
  isNoChange,
  isRealName,
  quantityForProduct,
  singleConfiguredFee,
  stageForDraft,
  summary
} from './helpers.js';
import {
  createDeliveryOrder,
  getActiveProducts,
  getCustomer,
  getDeliveryStore,
  getSession,
  saveSession
} from './repository.js';
import type {
  DeliveryDraft,
  DeliveryProduct,
  DeliveryState
} from './types.js';

function addProducts(
  draft: DeliveryDraft,
  products: DeliveryProduct[],
  text: string
): void {
  for (const product of products) {
    const key = `${product.id}::`;

    const existing = draft.items.find(
      item => `${item.product_id}::${item.variation}` === key
    );

    const quantity = quantityForProduct(text, product);

    if (existing) {
      existing.quantity = quantity;
      continue;
    }

    draft.items.push({
      product_id: product.id,
      name: product.name,
      quantity,
      variation: '',
      unit_price: product.price,
      notes: ''
    });
  }
}

function parseChange(text: string): number | null {
  if (isNoChange(text)) return 0;

  const match = text.match(/\d+(?:[.,]\d+)?/);
  if (!match) return null;

  const value = Number(match[0].replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

function paymentQuestion(paymentMethods: string | null): string {
  const normalized = String(paymentMethods ?? '').trim();

  if (!normalized) {
    return 'E como você prefere pagar: Pix, dinheiro ou cartão? 😊';
  }

  return `E como você prefere pagar? Temos ${normalized}. 😊`;
}

function looksLikeThanks(text: string): boolean {
  const value = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

  return /^(obrigad[oa]|valeu|vlw|show|beleza|blz|ok|certo|perfeito|top)[.! ]*$/.test(
    value
  );
}

export class DeliveryHandler implements VerticalHandler {
  async handle(context: VerticalContext): Promise<string | null> {
    const { company, message, combinedText } = context;

    const [store, catalog, customer, session, recentConfirmed] =
      await Promise.all([
        getDeliveryStore(company.id),
        getActiveProducts(company.id),
        getCustomer(company.id, message.phone),
        getSession(company.id, message.phone),
        getRecentConfirmedOrder(company.id, message.phone)
      ]);

    if (!store) {
      return 'O atendimento está temporariamente indisponível. Vou chamar a equipe para te ajudar.';
    }

    let draft = session.draft ?? emptyDraft();
    const hadDraft = Boolean(session.draft?.items?.length);

    if (!isRealName(draft.client_name) && isRealName(customer?.name)) {
      draft.client_name = customer!.name;
    }

    const stageBefore = stageForDraft(draft);
    const directProducts = findProductsInMessage(combinedText, catalog);

    if (
      recentConfirmed &&
      !hadDraft &&
      directProducts.length === 0
    ) {
      if (looksLikeThanks(combinedText)) {
        return 'Por nada 😊 Seu pedido já está confirmado. Qualquer coisa, é só chamar.';
      }

      if (isConfirmation(combinedText)) {
        return 'Seu pedido já foi confirmado 😊 Não precisa confirmar novamente.';
      }
    }

    if (directProducts.length) {
      addProducts(draft, directProducts, combinedText);
    }

    const intent = await deliveryIntentService.extract({
      message: combinedText,
      expectedField: stageBefore,
      catalogNames: catalog.map(product => product.name)
    });

    if (!directProducts.length && intent.product_requests.length) {
      for (const request of intent.product_requests) {
        const matches = findProductsInMessage(request.query, catalog);

        for (const product of matches) {
          const existing = draft.items.find(
            item => item.product_id === product.id && !item.variation
          );

          if (existing) {
            existing.quantity = Math.max(1, request.quantity);
            existing.notes = request.notes || existing.notes;
          } else {
            draft.items.push({
              product_id: product.id,
              name: product.name,
              quantity: Math.max(1, request.quantity),
              variation: '',
              unit_price: product.price,
              notes: request.notes
            });
          }
        }
      }
    }

    if (!draft.items.length) {
      if (intent.intent === 'menu' || /card[aá]pio|menu/i.test(combinedText)) {
        return 'Claro 😊 Vou te mostrar o cardápio. [CARDAPIO_VISUAL_PENDENTE_V0_2]';
      }

      if (intent.intent === 'greeting') {
        return `Oi! 😊 Sou o atendimento do ${store.store_name}. O que você gostaria de pedir?`;
      }

      return 'Me diz qual item do cardápio você quer pedir 😊';
    }

    const stage = stageForDraft(draft);

    if (stage === 'waiting_name') {
      const name =
        extractName(combinedText) ||
        (isRealName(intent.customer_name) ? intent.customer_name.trim() : '');

      if (name) draft.client_name = name;
    }

    if (stage === 'waiting_delivery_type') {
      draft.delivery_type =
        detectDeliveryType(combinedText) ||
        intent.delivery_type ||
        draft.delivery_type;
    }

    if (
      stage === 'waiting_address' &&
      draft.delivery_type === 'delivery'
    ) {
      const direct = combinedText.trim();

      if (
        direct.length >= 5 &&
        !detectPayment(direct) &&
        !detectDeliveryType(direct) &&
        !isConfirmation(direct)
      ) {
        draft.delivery_address = direct;
      } else if (intent.address.trim()) {
        draft.delivery_address = intent.address.trim();
      }
    }

    if (stage === 'waiting_payment') {
      draft.payment_method =
        detectPayment(combinedText) ||
        intent.payment_method ||
        draft.payment_method;
    }

    if (
      stage === 'waiting_change' &&
      draft.payment_method === 'cash'
    ) {
      draft.change_for =
        parseChange(combinedText) ??
        intent.change_for ??
        draft.change_for;
    }

    if (draft.delivery_type === 'pickup') {
      draft.delivery_address = '';
      draft.delivery_fee = 0;
    }

    if (
      draft.delivery_type === 'delivery' &&
      draft.delivery_fee === null
    ) {
      draft.delivery_fee = singleConfiguredFee(store.delivery_fee);
    }

    if (draft.payment_method !== 'cash') {
      draft.change_for = null;
    }

    const nextState = stageForDraft(draft);

    if (
      nextState === 'waiting_confirmation' &&
      isConfirmation(combinedText)
    ) {
      const order = await createDeliveryOrder({
        companyId: company.id,
        phone: message.phone,
        pushName: message.pushName,
        draft
      });

      await saveSession({
        companyId: company.id,
        phone: message.phone,
        state: 'idle',
        draft: null
      });

      await markRecentConfirmedOrder(
        company.id,
        message.phone,
        order.id
      );

      const firstName = order.clientName
        .trim()
        .split(/\s+/)[0];

      let response =
        firstName && firstName.toLowerCase() !== 'cliente'
          ? `Fechou, ${firstName}! ✅ Seu pedido foi confirmado e já está com a equipe.`
          : 'Fechou! ✅ Seu pedido foi confirmado e já está com a equipe.';

      if (draft.payment_method === 'pix' && store.pix_key?.trim()) {
        response += `\n\nPix: ${store.pix_key.trim()}\nDepois do pagamento, pode mandar o comprovante por aqui.`;
      }

      return response;
    }

    await saveSession({
      companyId: company.id,
      phone: message.phone,
      state: nextState,
      draft
    });

    switch (nextState) {
      case 'waiting_name':
        return 'Como posso te chamar? 😊';

      case 'waiting_delivery_type':
        return 'Vai ser entrega ou retirada? 😊';

      case 'waiting_address':
        return 'Qual o endereço completo para entrega? 😊';

      case 'waiting_payment':
        return paymentQuestion(store.payment_methods);

      case 'waiting_change':
        return 'Precisa de troco? Se sim, pra quanto? 😊';

      case 'waiting_confirmation':
        if (
          draft.delivery_type === 'delivery' &&
          draft.delivery_fee === null
        ) {
          return 'Não consegui determinar a taxa de entrega com segurança. Vou chamar a equipe para te ajudar 😊';
        }

        return summary(draft);

      default:
        return 'Me diz qual item do cardápio você quer pedir 😊';
    }
  }
}

export const deliveryHandler = new DeliveryHandler();
