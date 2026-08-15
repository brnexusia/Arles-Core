import { deliveryIntentService } from './ai/intent.service.js';
import { deliveryConversationService } from './ai/conversation.service.js';
import { getRecentConfirmedOrder, markRecentConfirmedOrder } from './state.js';
import type { VerticalContext, VerticalHandler, VerticalResult } from '../vertical.js';
import {
  brl,
  detectDeliveryType,
  detectPayment,
  emptyDraft,
  extractName,
  findProductsInMessage,
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
import type { DeliveryDraft, DeliveryProduct, DeliveryState, PaymentMethod } from './types.js';
import { deliveryConfig } from './config.js';

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

function looksLikeReplacementSelection(text: string): boolean {
  const s = norm(text);
  if (/\b(adiciona|adicionar|acrescenta|acrescentar|mais um|mais uma|tambem|também|junto)\b/.test(s)) return false;
  return /^(vou querer|quero|queria|eu quero|so quero|só quero|fica so|fica só|deixa so|deixa só|vai ser)\b/.test(s);
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

function configuredPaymentMethods(value: string | null): PaymentMethod[] {
  const configured = norm(value);
  if (!configured) return ['pix', 'cash', 'card'];

  const methods: PaymentMethod[] = [];
  if (/\bpix\b/.test(configured)) methods.push('pix');
  if (/\b(dinheiro|especie|cash)\b/.test(configured)) methods.push('cash');
  if (/\b(cartao|credito|debito|maquininha)\b/.test(configured)) methods.push('card');

  return methods.length ? methods : ['pix', 'cash', 'card'];
}

function paymentMethodAllowed(method: PaymentMethod, configured: string | null): boolean {
  if (!method) return false;
  return configuredPaymentMethods(configured).includes(method);
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

function safeProductMatches(query: string, catalog: DeliveryProduct[]): DeliveryProduct[] {
  const matches = findProductsInMessage(query, catalog);
  if (matches.length <= 1) return matches;

  const message = norm(query);
  return matches.filter(product => {
    const name = norm(product.name);
    return !matches.some(other => {
      if (other.id === product.id) return false;
      const otherName = norm(other.name);
      return otherName.length > name.length &&
        otherName.includes(name) &&
        message.includes(otherName);
    });
  });
}

function bestProduct(query: string, catalog: DeliveryProduct[]): DeliveryProduct | null {
  const matches = safeProductMatches(query, catalog);
  return matches.length === 1 ? matches[0]! : null;
}

function configuredFeeForAddress(value: unknown, address: string): number | null {
  const single = singleConfiguredFee(value);
  if (single !== null) return single;

  const raw = String(value ?? '').trim();
  const normalizedAddress = norm(address);
  if (!raw || !normalizedAddress) return null;

  const parts = raw.split(/[\n;|]+/).map(item => item.trim()).filter(Boolean);
  for (const part of parts) {
    const number = part.match(/\d+(?:[.,]\d+)?/);
    if (!number) continue;

    const fee = Number(number[0].replace(',', '.'));
    if (!Number.isFinite(fee)) continue;

    const area = norm(part.replace(number[0], '').replace(/r\$/gi, ''));
    const tokens = area
      .split(/[^a-z0-9]+/)
      .filter(token => token.length >= 4 && !['taxa', 'entrega', 'bairro', 'valor'].includes(token));

    if (tokens.some(token => normalizedAddress.includes(token))) return fee;
  }

  return null;
}

function unresolvedProductQuestion(terms: string[], catalog: DeliveryProduct[]): string {
  const cleanTerms = [...new Set(terms.map(term => term.trim()).filter(Boolean))];
  const label = cleanTerms.slice(0, 3).join(', ');
  const normalized = norm(label);

  const beverageLike = /\b(coca|coca cola|refri|refrigerante|guarana|guaraná|fanta|sprite|pepsi|bebida)\b/.test(normalized);
  if (beverageLike) {
    const options = catalog
      .filter(product => /bebida|refrigerante|suco|agua|água/.test(norm(`${product.category} ${product.name}`)))
      .slice(0, 5);

    if (options.length) {
      return `Anotei o que consegui identificar. Sobre ${label || 'a bebida'}, no cardápio tenho ${options.map(item => `${item.name} (${brl(item.price)})`).join(', ')}. Qual você quer?`;
    }
  }

  return `Anotei o que consegui identificar, mas não encontrei “${label || 'esse item'}” com segurança no cardápio. Qual item do cardápio você quer no lugar?`;
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
      return textResult('O atendimento está temporariamente indisponível. Tenta novamente em alguns instantes, por favor.');
    }

    if (store.ai_enabled === false) return null;

    let draft = session.draft ?? emptyDraft();
    const hadDraft = Boolean(session.draft?.items?.length);
    const editingOrder = session.state === 'editing_order';

    if (!isRealName(draft.client_name) && isRealName(customer?.name)) {
      draft.client_name = customer!.name;
    }

    // Sessões antigas também não podem carregar uma forma de pagamento que a loja não aceita.
    if (draft.payment_method && !paymentMethodAllowed(draft.payment_method, store.payment_methods)) {
      draft.payment_method = '';
      draft.change_for = null;
    }

    const directProducts = safeProductMatches(combinedText, catalog);

    // Encerramento pós-pedido é determinístico e acontece antes da IA.
    // Assim “obrigada/obrigado/valeu” nunca é reinterpretado como uma nova saudação.
    if (recentConfirmed && !hadDraft && directProducts.length === 0) {
      if (isThanks(combinedText)) {
        return textResult('Por nada 😊 Seu pedido já está confirmado. Bom apetite!');
      }
      if (isConfirmation(combinedText)) {
        return textResult('Seu pedido já foi confirmado 😊 Não precisa confirmar novamente.');
      }
    }

    // Caminhos óbvios não precisam gastar IA.
    if (isMenuRequest(combinedText)) {
      if (menuAssets.length) return menuResult('Claro! 😊 Aqui está nosso cardápio:', menuAssets);
      if (catalog.length) {
        const lines = catalog.slice(0, 30).map(product => `• ${product.name} — ${brl(product.price)}`);
        return textResult(`Claro! 😊 Nosso cardápio disponível agora:\n\n${lines.join('\n')}`);
      }
      return textResult('Nosso cardápio está sendo atualizado agora. Me diz o que você procura que eu tento te ajudar 😊');
    }

    if (!hadDraft && isGreeting(combinedText)) {
      if (menuAssets.length) return menuResult('Oi! 😊 Aqui está nosso cardápio:', menuAssets);
      return textResult(`Oi! 😊 Sou o atendimento do ${store.store_name}. O que você gostaria de pedir?`);
    }

    if (!hadDraft && !looksLikeOrderVerb(combinedText)) {
      const deterministic = deterministicQuestionAnswer({
        text: combinedText,
        store,
        products: directProducts
      });
      if (deterministic) return textResult(deterministic);
    }

    const stageBefore = editingOrder ? 'editing_order' : stageForDraft(draft);
    const intent = await deliveryIntentService.extract({
      message: combinedText,
      expectedField: stageBefore,
      catalog: catalog.map(product => ({ name: product.name, variations: product.variations })),
      hasDraft: hadDraft,
      hasRecentConfirmedOrder: Boolean(recentConfirmed),
      draftItems: draft.items.map(item => `${item.quantity}x ${item.name}${item.variation ? ` (${item.variation})` : ''}`),
      recentHistory: history
    });

    if (intent.intent === 'menu') {
      if (menuAssets.length) return menuResult('Claro! 😊 Aqui está nosso cardápio:', menuAssets);
      if (catalog.length) {
        const lines = catalog.slice(0, 30).map(product => `• ${product.name} — ${brl(product.price)}`);
        return textResult(`Claro! 😊 Nosso cardápio disponível agora:\n\n${lines.join('\n')}`);
      }
    }

    if (!hadDraft && intent.intent === 'greeting') {
      return textResult(`Oi! 😊 Sou o atendimento do ${store.store_name}. O que você gostaria de pedir?`);
    }

    // O Arles Delivery não transborda automaticamente: mesmo se pedirem humano,
    // a conversa continua no próprio atendente digital.
    if (intent.intent === 'human') {
      return textResult('Eu consigo continuar seu atendimento por aqui 😊 Me diz o que você precisa resolver no pedido.');
    }

    if (intent.intent === 'cancel' && hadDraft && !recentConfirmed) {
      await saveSession({ companyId: company.id, phone: message.phone, state: 'idle', draft: null });
      return textResult('Certo, cancelei esse pedido em andamento. Se quiser começar outro, é só me dizer o que vai querer 😊');
    }

    if (!hadDraft && intent.intent === 'question') {
      const deterministic = deterministicQuestionAnswer({ text: combinedText, store, products: directProducts });
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

    // Em modo de edição, uma nova seleção (“vou querer...”) substitui os itens antigos.
    // “adiciona/acrescenta” continua acrescentando normalmente.
    const shouldReplaceItems = editingOrder &&
      (intent.order_action === 'replace' ||
        (looksLikeReplacementSelection(combinedText) && intent.order_action !== 'add')) &&
      (intent.product_requests.length > 0 || directProducts.length > 0);

    if (shouldReplaceItems) draft.items = [];

    const removed = productsToRemove(combinedText, catalog);
    if (draft.items.length && removed.length) {
      const ids = new Set(removed.map(product => product.id));
      draft.items = draft.items.filter(item => !ids.has(item.product_id));
    }

    if (intent.order_action === 'remove' && intent.product_requests.length) {
      const ids = new Set(
        intent.product_requests
          .map(request => bestProduct(request.query, catalog)?.id)
          .filter((id): id is string => Boolean(id))
      );
      if (ids.size) draft.items = draft.items.filter(item => !ids.has(item.product_id));
    }

    const wantsOrder =
      hadDraft ||
      editingOrder ||
      intent.intent === 'order' ||
      looksLikeOrderVerb(combinedText);

    const unresolved = new Set<string>(intent.unrecognized_products);

    if (wantsOrder && intent.order_action !== 'remove' && intent.order_action !== 'keep') {
      const handledByAi = new Set<string>();

      for (const request of intent.product_requests) {
        const product = bestProduct(request.query, catalog);
        if (!product) {
          if (request.query.trim()) unresolved.add(request.query.trim());
          continue;
        }

        handledByAi.add(product.id);
        addOrUpdateProduct(
          draft,
          product,
          Math.max(1, request.quantity),
          request.variation,
          request.notes
        );
      }

      for (const product of directProducts) {
        if (handledByAi.has(product.id)) continue;
        addOrUpdateProduct(draft, product, quantityForProduct(combinedText, product));
      }
    }

    if (draft.items.length && intent.observation.trim() && !intent.product_requests.length) {
      const lastItem = draft.items[draft.items.length - 1];
      if (lastItem) lastItem.notes = intent.observation.trim();
    }

    if (!draft.items.length && directProducts.length && intent.intent !== 'question' && intent.order_action !== 'remove') {
      for (const product of directProducts) {
        addOrUpdateProduct(draft, product, quantityForProduct(combinedText, product));
      }
    }

    if (unresolved.size) {
      const state: DeliveryState = editingOrder ? 'editing_order' : stageForDraft(draft);
      await saveSession({ companyId: company.id, phone: message.phone, state, draft: draft.items.length ? draft : null });
      return textResult(unresolvedProductQuestion([...unresolved], catalog));
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
      const requestedPayment = detectPayment(combinedText) || intent.payment_method;
      if (requestedPayment && !paymentMethodAllowed(requestedPayment, store.payment_methods)) {
        draft.payment_method = '';
        draft.change_for = null;
        await saveSession({ companyId: company.id, phone: message.phone, state: 'waiting_payment', draft });
        return textResult(`Essa forma de pagamento não está disponível. ${paymentQuestion(store.payment_methods)}`);
      }
      draft.payment_method = requestedPayment || draft.payment_method;
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
      draft.delivery_fee = configuredFeeForAddress(store.delivery_fee, draft.delivery_address);
    }

    if (draft.payment_method !== 'cash') draft.change_for = null;

    let nextState = stageForDraft(draft);

    if (nextState === 'waiting_confirmation' && isRejection(combinedText)) {
      await saveSession({ companyId: company.id, phone: message.phone, state: 'editing_order', draft });
      return textResult('Claro 😊 Me diz o que você quer mudar. Pode falar naturalmente, por exemplo: “vou querer só uma Calabresa” ou “adiciona um refrigerante”.');
    }

    if (nextState === 'waiting_confirmation' && isConfirmation(combinedText)) {
      const order = await createDeliveryOrder({
        companyId: company.id,
        phone: message.phone,
        pushName: message.pushName,
        draft
      });

      await saveSession({ companyId: company.id, phone: message.phone, state: 'idle', draft: null });
      await markRecentConfirmedOrder(
        company.id,
        message.phone,
        order.id,
        deliveryConfig.recentConfirmedTtlSeconds
      );

      const firstName = order.clientName.trim().split(/\s+/)[0];
      let response = firstName && firstName.toLowerCase() !== 'cliente'
        ? `Fechou, ${firstName}! ✅ Seu pedido foi confirmado e já entrou na fila de preparo.`
        : 'Fechou! ✅ Seu pedido foi confirmado e já entrou na fila de preparo.';

      if (draft.payment_method === 'pix' && store.pix_key?.trim()) {
        response += `\n\nPix: ${store.pix_key.trim()}\nDepois do pagamento, pode mandar o comprovante por aqui.`;
      }

      return textResult(response);
    }

    if (nextState === 'waiting_confirmation' && draft.delivery_type === 'delivery' && draft.delivery_fee === null) {
      // Não inventa taxa e não transborda: pede o dado que falta e continua sozinho.
      draft.delivery_address = '';
      nextState = 'waiting_address';
      await saveSession({ companyId: company.id, phone: message.phone, state: nextState, draft });
      return textResult('Me manda o endereço completo com o bairro para eu calcular a taxa de entrega certinho 😊');
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
        return textResult(summary(draft), {
          followup: { text: 'Oi 😊 Quer confirmar seu pedido?' }
        });
      default:
        return textResult('Me diz qual item do cardápio você quer pedir 😊');
    }
  }
}

export const deliveryHandler = new DeliveryHandler();
