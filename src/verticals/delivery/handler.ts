import { deliveryIntentService } from '../../ai/delivery-intent.service.js';
import { deliveryConversationService } from '../../ai/delivery-conversation.service.js';
import { env } from '../../config/env.js';
import { getRecentConfirmedOrder, markRecentConfirmedOrder } from '../../infrastructure/redis.js';
import type { VerticalContext, VerticalHandler, VerticalResult } from '../vertical.js';
import {
  brl,
  detectDeliveryType,
  detectPayment,
  emptyDraft,
  extractName,
  findProductsInMessage,
  handoffReason,
  isConfirmation,
  isGreeting,
  isMenuRequest,
  isNoChange,
  isRealName,
  isRejection,
  isThanks,
  norm,
  productsToRemove,
  quantityForProduct,
  singleConfiguredFee,
  stageForDraft,
  summary
} from './helpers.js';
import {
  createDeliveryOrder,
  getActiveProducts,
  getCompanySettings,
  getCustomer,
  getDeliveryStore,
  getMenuAssets,
  getRecentMessages,
  getSession,
  saveSession
} from './repository.js';
import type { DeliveryDraft, DeliveryProduct } from './types.js';

function textResult(text: string, extra: Partial<VerticalResult> = {}): VerticalResult {
  return { actions: [{ type: 'text', text }], ...extra };
}

function menuResult(intro: string, assets: Array<{ asset_url: string }>): VerticalResult {
  return {
    actions: [
      { type: 'text', text: intro },
      ...assets.filter(a => a.asset_url).map(a => ({ type: 'image' as const, mediaUrl: a.asset_url }))
    ]
  };
}


function looksLikeOrderVerb(text: string): boolean {
  return /\b(quero|queria|manda|mandar|me ve|me vê|me manda|vou querer|pode colocar|coloca|adiciona|acrescenta|faz|separa)\b/.test(norm(text));
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
  if (!normalized) return 'E como você prefere pagar: Pix, dinheiro ou cartão? 😊';
  return `E como você prefere pagar? Temos ${normalized}. 😊`;
}


function deterministicQuestionAnswer(input: {
  text: string;
  store: {
    avg_time: string | null;
    opening_hours: string | null;
    delivery_fee: string | null;
    neighborhoods: string | null;
    payment_methods: string | null;
  };
  products: DeliveryProduct[];
}): string | null {
  const s = norm(input.text);
  const product = input.products.length === 1 ? input.products[0]! : null;

  if (
    product &&
    /\b(quanto|valor|preco|preço|custa|qual preco|qual preço|quanto custa|quanto e|quanto é)\b/.test(s)
  ) {
    return `${product.name} custa ${brl(product.price)} 😊`;
  }

  if (
    product &&
    /\b(tem|tem ai|tem aí|disponivel|disponível|vende|vocês tem|voces tem)\b/.test(s)
  ) {
    return `Tem sim 😊 ${product.name} está disponível por ${brl(product.price)}.`;
  }

  if (
    product &&
    /\b(o que vem|o que vai|ingrediente|ingredientes|acompanha|descricao|descrição)\b/.test(s)
  ) {
    return product.description
      ? `${product.name}: ${product.description}`
      : `Tenho ${product.name} disponível por ${brl(product.price)} 😊`;
  }

  if (
    /\b(forma de pagamento|formas de pagamento|como paga|como posso pagar|aceita pix|aceita cartao|aceita cartão|aceita dinheiro)\b/.test(s) &&
    input.store.payment_methods
  ) {
    return `Aceitamos ${input.store.payment_methods}.`;
  }

  if (
    /\b(taxa|taxa de entrega|valor da entrega|quanto e a entrega|quanto é a entrega|frete)\b/.test(s) &&
    input.store.delivery_fee
  ) {
    return `A taxa de entrega é ${input.store.delivery_fee}.`;
  }

  if (
    /\b(tempo|demora|quanto tempo|previsao|previsão|prazo)\b/.test(s) &&
    input.store.avg_time
  ) {
    return `O tempo médio informado é ${input.store.avg_time}.`;
  }

  if (
    /\b(horario|horário|que horas|abre|fecha|funciona ate|funciona até|funcionamento)\b/.test(s) &&
    input.store.opening_hours
  ) {
    return `Nosso horário: ${input.store.opening_hours}.`;
  }

  if (
    /\b(entrega onde|quais bairros|bairro|regiao|região|area de entrega|área de entrega)\b/.test(s) &&
    input.store.neighborhoods
  ) {
    return `Atendemos: ${input.store.neighborhoods}.`;
  }

  return null;
}

function addOrUpdateProduct(
  draft: DeliveryDraft,
  product: DeliveryProduct,
  quantity: number,
  variationName = '',
  notes = ''
): void {
  let unitPrice = product.price;
  let canonicalVariation = '';

  if (variationName) {
    const wanted = norm(variationName);
    const variation = (product.variations ?? []).find(v =>
      norm(v.name) === wanted || norm(v.name).includes(wanted) || wanted.includes(norm(v.name))
    );
    if (variation) {
      canonicalVariation = variation.name;
      unitPrice = Math.round((product.price + Number(variation.price_delta || 0)) * 100) / 100;
    }
  }

  const existing = draft.items.find(item =>
    item.product_id === product.id && norm(item.variation) === norm(canonicalVariation)
  );

  if (existing) {
    existing.quantity = Math.max(1, quantity);
    if (notes) existing.notes = notes;
    existing.unit_price = unitPrice;
    return;
  }

  draft.items.push({
    product_id: product.id,
    name: product.name,
    quantity: Math.max(1, quantity),
    variation: canonicalVariation,
    unit_price: unitPrice,
    notes
  });
}

function bestProduct(query: string, catalog: DeliveryProduct[]): DeliveryProduct | null {
  const matches = findProductsInMessage(query, catalog);
  return matches.length === 1 ? matches[0]! : null;
}

export class DeliveryHandler implements VerticalHandler {
  async handle(context: VerticalContext): Promise<VerticalResult | null> {
    const { company, message, combinedText } = context;

    const [
      store,
      catalog,
      settings,
      customer,
      session,
      recentConfirmed,
      menuAssets,
      history
    ] = await Promise.all([
      getDeliveryStore(company.id),
      getActiveProducts(company.id),
      getCompanySettings(company.id),
      getCustomer(company.id, message.phone),
      getSession(company.id, message.phone),
      getRecentConfirmedOrder(company.id, message.phone),
      getMenuAssets(company.id),
      getRecentMessages(company.id, message.phone)
    ]);

    if (!store) {
      return textResult('O atendimento está temporariamente indisponível. Vou chamar a equipe para te ajudar.', {
        pauseSeconds: env.humanPauseSeconds
      });
    }

    let draft = session.draft ?? emptyDraft();
    const hadDraft = Boolean(session.draft?.items?.length);

    if (!isRealName(draft.client_name) && isRealName(customer?.name)) {
      draft.client_name = customer!.name;
    }

    const stageBefore = stageForDraft(draft);
    const directProducts = findProductsInMessage(combinedText, catalog);
    const directHandoff = handoffReason(combinedText, Boolean(recentConfirmed));

    const intent = await deliveryIntentService.extract({
      message: combinedText,
      expectedField: stageBefore,
      catalog: catalog.map(product => ({ name: product.name, variations: product.variations })),
      hasDraft: hadDraft,
      hasRecentConfirmedOrder: Boolean(recentConfirmed)
    });

    const reason = directHandoff || (intent.handoff ? intent.handoff_reason || 'Atendimento humano solicitado' : null);
    if (reason) {
      return textResult('Entendi. Vou deixar a equipe continuar com você por aqui 😊', {
        pauseSeconds: env.humanPauseSeconds
      });
    }

    // Proteção pós-pedido: não reconstrói o checkout anterior por memória/conversa.
    if (recentConfirmed && !hadDraft && directProducts.length === 0) {
      if (isThanks(combinedText)) {
        return textResult('Por nada 😊 Seu pedido já está confirmado. Qualquer coisa, é só chamar.');
      }
      if (isConfirmation(combinedText)) {
        return textResult('Seu pedido já foi confirmado 😊 Não precisa confirmar novamente.');
      }
    }

    // Cardápio visual e saudação simples, como no workflow do n8n.
    if (!hadDraft && (isMenuRequest(combinedText) || intent.intent === 'menu' || isGreeting(combinedText) || intent.intent === 'greeting')) {
      if (menuAssets.length) {
        return menuResult('Oi! 😊 Aqui está nosso cardápio:', menuAssets);
      }
      if (isGreeting(combinedText) || intent.intent === 'greeting') {
        return textResult(`Oi! 😊 Sou o atendimento do ${store.store_name}. O que você gostaria de pedir?`);
      }
    }

    // Perguntas comuns são respondidas por código quando possível:
    // mais rápido e sem risco de a IA inventar preço/taxa/horário.
    if (!hadDraft && !looksLikeOrderVerb(combinedText)) {
      const deterministic = deterministicQuestionAnswer({
        text: combinedText,
        store,
        products: directProducts
      });

      if (deterministic) return textResult(deterministic);
    }

    // Perguntas sobre produto/loja não viram pedido automaticamente.
    if (!hadDraft && intent.intent === 'question') {
      const deterministic = deterministicQuestionAnswer({
        text: combinedText,
        store,
        products: directProducts
      });

      if (deterministic) return textResult(deterministic);

      const answer = await deliveryConversationService.answer({
        message: combinedText,
        store,
        customer,
        catalog,
        history,
        settings
      });
      return textResult(answer);
    }

    // Remove itens somente com comando explícito.
    const removed = productsToRemove(combinedText, catalog);
    if (draft.items.length && removed.length) {
      const ids = new Set(removed.map(product => product.id));
      draft.items = draft.items.filter(item => !ids.has(item.product_id));
    }

    const wantsOrder =
      hadDraft ||
      intent.intent === 'order' ||
      looksLikeOrderVerb(combinedText);

    if (wantsOrder) {
      const handledByAi = new Set<string>();

      // Quando a IA conseguiu extrair quantidade/variação/observação,
      // ela ajuda na interpretação, mas o produto/preço continuam vindo do catálogo real.
      for (const request of intent.product_requests) {
        const product = bestProduct(request.query, catalog);
        if (!product) continue;

        handledByAi.add(product.id);
        addOrUpdateProduct(
          draft,
          product,
          Math.max(1, request.quantity),
          request.variation,
          request.notes
        );
      }

      // Fallback determinístico para produto real mencionado na mensagem.
      for (const product of directProducts) {
        if (handledByAi.has(product.id)) continue;
        addOrUpdateProduct(
          draft,
          product,
          quantityForProduct(combinedText, product)
        );
      }
    }

    // Observação solta durante checkout: aplica ao último item em vez de confundir com nome.
    if (draft.items.length && intent.observation.trim() && !intent.product_requests.length) {
      const lastItem = draft.items[draft.items.length - 1];
      if (lastItem) lastItem.notes = intent.observation.trim();
    }

    if (!draft.items.length) {
      if (directProducts.length && intent.intent !== 'question') {
        // Produto real mencionado mas classificador ficou indeciso.
        for (const product of directProducts) {
          addOrUpdateProduct(draft, product, quantityForProduct(combinedText, product));
        }
      }
    }

    if (!draft.items.length) {
      const answer = await deliveryConversationService.answer({
        message: combinedText,
        store,
        customer,
        catalog,
        history,
        settings
      });
      return textResult(answer);
    }

    let stage = stageForDraft(draft);

    if (stage === 'waiting_name') {
      const aiName = isRealName(intent.customer_name) ? intent.customer_name.trim() : '';
      const directName = stageBefore === 'waiting_name' ? extractName(combinedText) : '';
      const name = aiName || directName;
      if (name) draft.client_name = name;
    }

    stage = stageForDraft(draft);
    if (stage === 'waiting_delivery_type') {
      draft.delivery_type = detectDeliveryType(combinedText) || intent.delivery_type || draft.delivery_type;
    }

    stage = stageForDraft(draft);
    if (stage === 'waiting_address' && draft.delivery_type === 'delivery') {
      const direct = combinedText.trim();
      if (
        direct.length >= 5 &&
        !detectPayment(direct) &&
        !detectDeliveryType(direct) &&
        !isConfirmation(direct) &&
        !isRejection(direct)
      ) {
        draft.delivery_address = direct;
      } else if (intent.address.trim()) {
        draft.delivery_address = intent.address.trim();
      }
    }

    stage = stageForDraft(draft);
    if (stage === 'waiting_payment') {
      draft.payment_method = detectPayment(combinedText) || intent.payment_method || draft.payment_method;
    }

    stage = stageForDraft(draft);
    if (stage === 'waiting_change' && draft.payment_method === 'cash') {
      draft.change_for = parseChange(combinedText) ?? intent.change_for ?? draft.change_for;
    }

    if (draft.delivery_type === 'pickup') {
      draft.delivery_address = '';
      draft.delivery_fee = 0;
    }

    if (draft.delivery_type === 'delivery' && draft.delivery_fee === null) {
      draft.delivery_fee = singleConfiguredFee(store.delivery_fee);
    }

    if (draft.payment_method !== 'cash') draft.change_for = null;

    const nextState = stageForDraft(draft);

    if (nextState === 'waiting_confirmation' && isRejection(combinedText)) {
      await saveSession({ companyId: company.id, phone: message.phone, state: nextState, draft });
      return textResult('Claro 😊 Me diz o que você quer ajustar no pedido.');
    }

    if (nextState === 'waiting_confirmation' && isConfirmation(combinedText)) {
      const order = await createDeliveryOrder({
        companyId: company.id,
        phone: message.phone,
        pushName: message.pushName,
        draft
      });

      await saveSession({ companyId: company.id, phone: message.phone, state: 'idle', draft: null });
      await markRecentConfirmedOrder(company.id, message.phone, order.id);

      const firstName = order.clientName.trim().split(/\s+/)[0];
      let response = firstName && firstName.toLowerCase() !== 'cliente'
        ? `Fechou, ${firstName}! ✅ Seu pedido foi confirmado e já está com a equipe. Vou te atualizando por aqui 😊`
        : 'Fechou! ✅ Seu pedido foi confirmado e já está com a equipe. Vou te atualizando por aqui 😊';

      if (draft.payment_method === 'pix' && store.pix_key?.trim()) {
        response += `\n\nPix: ${store.pix_key.trim()}\nDepois do pagamento, pode mandar o comprovante por aqui.`;
      }

      return textResult(response);
    }

    await saveSession({ companyId: company.id, phone: message.phone, state: nextState, draft });

    switch (nextState) {
      case 'waiting_name':
        return textResult('Como posso te chamar? 😊');
      case 'waiting_delivery_type':
        return textResult('Vai ser entrega ou retirada? 😊');
      case 'waiting_address':
        return textResult('Qual o endereço completo para entrega? 😊');
      case 'waiting_payment':
        return textResult(paymentQuestion(store.payment_methods));
      case 'waiting_change':
        return textResult('Precisa de troco? Se sim, pra quanto? 😊');
      case 'waiting_confirmation':
        if (draft.delivery_type === 'delivery' && draft.delivery_fee === null) {
          return textResult('Não consegui determinar a taxa de entrega com segurança. Vou chamar a equipe para te ajudar 😊', {
            pauseSeconds: env.humanPauseSeconds
          });
        }
        return textResult(summary(draft), { followupEligible: true });
      default:
        return textResult('Me diz qual item do cardápio você quer pedir 😊');
    }
  }
}

export const deliveryHandler = new DeliveryHandler();
