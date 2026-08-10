import type {
  DeliveryDraft,
  DeliveryProduct,
  DeliveryState,
  DeliveryType,
  PaymentMethod
} from './types.js';

export function norm(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

export function brl(value: number): string {
  return `R$ ${Number(value || 0).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

export function isRealName(value: unknown): boolean {
  const s = String(value ?? '').trim();

  return Boolean(
    s &&
    s.length >= 2 &&
    s.length <= 80 &&
    !/^cliente$/i.test(s) &&
    !/^unknown$/i.test(s) &&
    !/^desconhecido$/i.test(s) &&
    !/^\+?\d+$/.test(s)
  );
}

export function extractName(value: string): string {
  let s = value.trim();

  s = s
    .replace(
      /^(meu nome (?:é|e)|sou|pode me chamar de|me chama de)\s+/i,
      ''
    )
    .trim();

  if (!isRealName(s)) return '';
  if (/\d/.test(s)) return '';
  if (detectDeliveryType(s) || detectPayment(s) || isConfirmation(s)) return '';
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ'´` -]+$/.test(s)) return '';

  return s;
}

export function detectDeliveryType(value: string): DeliveryType {
  const s = norm(value);

  if (/\b(entrega|delivery|entregar)\b/.test(s)) return 'delivery';
  if (/\b(retirada|retirar|buscar|pickup)\b/.test(s)) return 'pickup';

  return '';
}

export function detectPayment(value: string): PaymentMethod {
  const s = norm(value);

  if (/\bpix\b/.test(s)) return 'pix';
  if (/\b(dinheiro|cash)\b/.test(s)) return 'cash';
  if (/\b(cartao|credito|debito|card)\b/.test(s)) return 'card';

  return '';
}

export function isConfirmation(value: string): boolean {
  const s = norm(value);

  return /^(sim|confirmo|sim confirmo|pode confirmar|pode fechar|fechado|pode ser|isso|isso mesmo|correto|ta certo|ok|pode mandar|manda ver|pode finalizar)[.! ]*$/.test(
    s
  );
}

export function isNoChange(value: string): boolean {
  const s = norm(value);

  return /^(nao|nao precisa|sem troco|nao quero|so isso|isso e tudo)[.! ]*$/.test(
    s
  );
}

export function singleConfiguredFee(value: unknown): number | null {
  const s = String(value ?? '').trim();
  if (!s) return null;

  const matches = s.match(/\d+(?:[.,]\d+)?/g) || [];
  const numbers = matches
    .map(item => Number(item.replace(',', '.')))
    .filter(Number.isFinite);

  return numbers.length === 1 ? numbers[0]! : null;
}

export function emptyDraft(): DeliveryDraft {
  return {
    client_name: '',
    items: [],
    observations: '',
    delivery_type: '',
    delivery_address: '',
    payment_method: '',
    change_for: null,
    delivery_fee: null
  };
}

export function stageForDraft(draft: DeliveryDraft): DeliveryState {
  if (!draft.items.length) return 'idle';
  if (!isRealName(draft.client_name)) return 'waiting_name';
  if (!draft.delivery_type) return 'waiting_delivery_type';
  if (draft.delivery_type === 'delivery' && !draft.delivery_address) {
    return 'waiting_address';
  }
  if (!draft.payment_method) return 'waiting_payment';
  if (draft.payment_method === 'cash' && draft.change_for === null) {
    return 'waiting_change';
  }
  return 'waiting_confirmation';
}

export function findProductsInMessage(
  text: string,
  catalog: DeliveryProduct[]
): DeliveryProduct[] {
  const message = norm(text);
  const exact: DeliveryProduct[] = [];
  const tokenMatches: Array<{ product: DeliveryProduct; hits: number }> = [];

  const stop = new Set([
    'pizza',
    'pizzas',
    'com',
    'sem',
    'para',
    'uma',
    'umas',
    'quero',
    'manda',
    'mandar',
    'pedir',
    'pedido',
    'por',
    'favor',
    'pfv',
    'de',
    'da',
    'do',
    'grande',
    'media',
    'pequena'
  ]);

  for (const product of catalog) {
    const productName = norm(product.name);
    if (!productName) continue;

    if (message.includes(productName)) {
      exact.push(product);
      continue;
    }

    const tokens = productName
      .split(/[^a-z0-9]+/)
      .filter(token => token.length >= 4 && !stop.has(token));

    const hits = tokens.filter(token => message.includes(token)).length;

    if (hits) tokenMatches.push({ product, hits });
  }

  if (exact.length) return exact;

  if (tokenMatches.length === 1) {
    return [tokenMatches[0]!.product];
  }

  const sorted = tokenMatches.sort((a, b) => b.hits - a.hits);

  if (
    sorted.length &&
    sorted[0]!.hits > (sorted[1]?.hits ?? 0)
  ) {
    return [sorted[0]!.product];
  }

  return [];
}

export function quantityForProduct(
  text: string,
  product: DeliveryProduct
): number {
  const message = norm(text);
  const firstToken = norm(product.name)
    .split(/[^a-z0-9]+/)
    .find(token => token.length >= 4);

  if (!firstToken) return 1;

  const regex = new RegExp(
    `\\b(\\d+)\\s*(?:x\\s*)?(?:pizza[s]?\\s*)?${firstToken}\\b`,
    'i'
  );

  const match = message.match(regex);
  return match ? Math.max(1, Number(match[1]) || 1) : 1;
}

export function summary(draft: DeliveryDraft): string {
  const subtotal = draft.items.reduce(
    (sum, item) => sum + item.unit_price * item.quantity,
    0
  );

  const fee =
    draft.delivery_type === 'delivery'
      ? Number(draft.delivery_fee || 0)
      : 0;

  const total = Math.round((subtotal + fee) * 100) / 100;

  const lines = draft.items.map(
    item => `• ${item.quantity}x ${item.name} — ${brl(item.unit_price * item.quantity)}`
  );

  const payment =
    draft.payment_method === 'pix'
      ? 'Pix'
      : draft.payment_method === 'cash'
        ? 'Dinheiro'
        : 'Cartão';

  const delivery =
    draft.delivery_type === 'delivery'
      ? `Entrega — ${draft.delivery_address}`
      : 'Retirada no local';

  const change =
    draft.payment_method === 'cash'
      ? Number(draft.change_for) > 0
        ? `\n• Troco para ${brl(Number(draft.change_for))}`
        : '\n• Sem troco'
      : '';

  return [
    'Fechado! 😊 Confere pra mim:',
    '',
    ...lines,
    `• Subtotal — ${brl(subtotal)}`,
    ...(draft.delivery_type === 'delivery'
      ? [`• Taxa de entrega — ${brl(fee)}`]
      : []),
    `• Total — ${brl(total)}`,
    `• ${delivery}`,
    `• Pagamento — ${payment}${change}`,
    '',
    'Posso confirmar seu pedido?'
  ].join('\n');
}
