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
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function stripTrailingPunctuation(value: string): string {
  return norm(value).replace(/[.!?,;:]+$/g, '').trim();
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
    !/^sem nome$/i.test(s) &&
    !/^\+?\d+$/.test(s)
  );
}

export function looksLikeOrderInstruction(value: string): boolean {
  const s = norm(value);
  return /^(sem |com |tira |tirar |remove |remover |retira |adiciona |adicionar |acrescenta |obs\b|observacao\b|quero |queria |eu quero |manda |mandar |me ve |me vê |coloca |bota |faz |separa |vou querer |vou de )/.test(s);
}

export function extractName(value: string): string {
  let s = String(value ?? '').trim();

  s = s
    .replace(
      /^(?:meu nome (?:é|e)|me chamo|eu sou|sou o|sou a|sou|pode me chamar de|pode chamar de|me chama de|chama de|aqui (?:é|e)|é|e)\s+/i,
      ''
    )
    .replace(/\s+(?:aqui|mesmo)$/i, '')
    .trim();

  if (!isRealName(s)) return '';
  if (/\d/.test(s)) return '';
  if (looksLikeOrderInstruction(s)) return '';
  if (
    detectDeliveryType(s) ||
    detectPayment(s) ||
    isConfirmation(s) ||
    isRejection(s) ||
    isNoChange(s) ||
    isMenuRequest(s)
  ) return '';

  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ'´` -]+$/.test(s)) return '';
  return s;
}

export function detectDeliveryType(value: string): DeliveryType {
  const s = norm(value);

  if (
    /\b(entrega|delivery|entregar|entrega aqui|manda aqui|manda pra ca|manda pra cá|traz aqui|trazer aqui|pode entregar|pra entregar|para entregar|leva aqui|quero entrega|vai ser entrega|receber em casa|manda no endereco|manda no endereço)\b/.test(s)
  ) {
    return 'delivery';
  }

  if (
    /\b(retirada|retirar|retiro|buscar|busco|pegar|pego|pickup|vou buscar|vou pegar|passo ai|passo aí|passar ai|passar aí|no balcao|no balcão|retira ai|retira aí|retiro ai|retiro aí|vou ai buscar|vou aí buscar|vou buscar ai|vou buscar aí|pego no local|buscar no local)\b/.test(s)
  ) {
    return 'pickup';
  }

  return '';
}

export function detectPayment(value: string): PaymentMethod {
  const s = norm(value);

  if (/\b(pix|via pix|no pix|pelo pix|pagar no pix|pago no pix|vou de pix|chave pix)\b/.test(s)) {
    return 'pix';
  }

  if (
    /\b(dinheiro|cash|especie|espécie|nota|cedula|cédula|em dinheiro|no dinheiro|pago em dinheiro|vou pagar em dinheiro)\b/.test(s)
  ) {
    return 'cash';
  }

  if (
    /\b(cartao|cartão|credito|crédito|debito|débito|maquininha|maquina|máquina|visa|mastercard|master|elo|card|no credito|no crédito|no debito|no débito|no cartao|no cartão|cartao na entrega|cartão na entrega)\b/.test(s)
  ) {
    return 'card';
  }

  return '';
}

export function isConfirmation(value: string): boolean {
  const s = stripTrailingPunctuation(value);

  // Formas digitadas rápido no WhatsApp.
  if (/^s+i+m+$/.test(s)) return true; // sim, simm, siim, siiimm
  if (/^s+$/.test(s)) return true; // s, ss
  if (/^y+e+s+$/.test(s)) return true;

  return /^(confirmo|confirmado|confirma|confirmar|claro|claro que sim|com certeza|aham|aham sim|uhum|uhum sim|pode|pode sim|sim pode|sim por favor|sim pfv|sim confirmo|pode confirmar|pode confirma|pode fechar|pode fazer|pode preparar|pode seguir|pode prosseguir|pode finalizar|pode mandar|manda ver|fecha|fechou|fechado|pode ser|isso|isso ai|isso aí|isso mesmo|exatamente|correto|certinho|ta certo|tá certo|esta certo|está certo|ok|okay|blz|beleza|show|perfeito|bora|vamos|vai|manda|vai nessa)$/.test(s);
}

export function isRejection(value: string): boolean {
  const s = stripTrailingPunctuation(value);

  if (/^n+a+o+$/.test(s)) return true;
  if (/^n+$/.test(s)) return true;

  return /^(nao|não|negativo|nop|nope|ainda nao|ainda não|agora nao|agora não|espera|espera ai|espera aí|pera|perai|pera ai|pera aí|calma|nao confirma|não confirma|nao ainda|não ainda|quero mudar|quero alterar|quero corrigir|preciso mudar|preciso alterar|tem que mudar|muda antes|altera antes)$/.test(s);
}

export function isNoChange(value: string): boolean {
  const s = stripTrailingPunctuation(value);

  if (/^n+a+o+$/.test(s)) return true;
  if (/^n+$/.test(s)) return true;

  return /^(nao precisa|não precisa|sem troco|nao quero troco|não quero troco|troco nao|troco não|valor exato|valor certinho|valor certo|pago certinho|sem|zero|0|nao|não)$/.test(s);
}

export function isMenuRequest(value: string): boolean {
  const s = norm(value);
  return /\b(cardapio|cardápio|menu|opcoes|opções|sabores|produtos|o que tem|oq tem|que voces tem|que vocês tem|o que vcs tem|oq vcs tem|o que vende|o que voces vendem|o que vocês vendem|quais opcoes|quais opções|me mostra o cardapio|me mostra o cardápio|me manda o cardapio|me manda o cardápio|manda o cardapio|manda o cardápio|manda menu|ver cardapio|ver cardápio|quero ver o cardapio|quero ver o cardápio)\b/.test(s);
}

export function isGreeting(value: string): boolean {
  const s = stripTrailingPunctuation(value);
  return /^(oi+|oie+|ola+|olá+|opa+|e ai+|e aí+|fala|salve|bom dia+|boa tarde+|boa noite+|tudo bem|td bem|tudo bom|td bom|oi tudo bem|ola tudo bem|olá tudo bem)$/.test(s);
}

export function isThanks(value: string): boolean {
  const s = stripTrailingPunctuation(value);
  return /^(obrigad[oa]|obg|brigad[oa]|muito obrigad[oa]|valeu+|vlw+|show|beleza|blz|certo|perfeito|top|massa|tmj|tamo junto|agradeco|agradeço)$/.test(s);
}

export function handoffReason(
  value: string,
  hasRecentConfirmedOrder = false
): string | null {
  const s = norm(value);

  if (
    /\b(atendente|atendimento humano|humano|pessoa de verdade|falar com alguem|falar com alguém|quero falar com alguem|quero falar com alguém|suporte|responsavel|responsável|gerente|dono|dona)\b/.test(s)
  ) {
    return 'Cliente pediu atendimento humano';
  }

  if (
    /\b(reclam|péssim|pessim|horrivel|horrível|absurdo|irritad|raiva|odiei|ruim demais|problema serio|problema sério|veio errado|pedido errado|faltou item|faltando item)\b/.test(s)
  ) {
    return 'Reclamação do cliente';
  }

  if (
    /\b(atrasad|atraso|demorando demais|demora demais|nao chegou|não chegou|cade meu pedido|cadê meu pedido|onde esta meu pedido|onde está meu pedido)\b/.test(s)
  ) {
    return 'Possível atraso de pedido';
  }

  if (
    /\b(cancelar pedido|cancela meu pedido|cancele meu pedido|quero cancelar|desiste do pedido|desisti do pedido)\b/.test(s)
  ) {
    return 'Pedido de cancelamento';
  }

  if (
    hasRecentConfirmedOrder &&
    /\b(alterar pedido|mudar pedido|trocar pedido|adicionar no pedido|acrescentar no pedido|tirar do pedido|remover do pedido|esqueci de pedir|esqueci um item|trocar endereco|trocar endereço|mudar endereco|mudar endereço|mudar pagamento)\b/.test(s)
  ) {
    return 'Alteração de pedido já confirmado';
  }

  return null;
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

const quantityWords: Record<string, number> = {
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  três: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10
};

function productTokens(productName: string): string[] {
  const stop = new Set([
    'pizza', 'pizzas', 'lanche', 'lanches', 'combo', 'combos',
    'com', 'sem', 'para', 'uma', 'umas', 'um', 'uns',
    'de', 'da', 'do', 'grande', 'media', 'pequena'
  ]);

  return norm(productName)
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !stop.has(token));
}

export function findProductsInMessage(
  text: string,
  catalog: DeliveryProduct[]
): DeliveryProduct[] {
  const message = norm(text);
  const exact: DeliveryProduct[] = [];
  const tokenMatches: Array<{ product: DeliveryProduct; hits: number }> = [];

  for (const product of catalog) {
    const productName = norm(product.name);
    if (!productName) continue;

    if (message.includes(productName)) {
      exact.push(product);
      continue;
    }

    const tokens = productTokens(product.name);
    const hits = tokens.filter(token => message.includes(token)).length;

    if (hits) {
      tokenMatches.push({ product, hits });
    }
  }

  if (exact.length) return exact;

  // Um único produto compatível é seguro.
  if (tokenMatches.length === 1) {
    return [tokenMatches[0]!.product];
  }

  const sorted = tokenMatches.sort((a, b) => b.hits - a.hits);

  // Só escolhe se houver vencedor claro.
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
  const tokens = productTokens(product.name);
  const firstToken = tokens[0];

  if (!firstToken) return 1;

  const digit = message.match(
    new RegExp(`\\b(\\d+)\\s*(?:x\\s*)?(?:pizza[s]?\\s*)?${firstToken}\\b`, 'i')
  );

  if (digit) {
    return Math.max(1, Math.min(50, Number(digit[1]) || 1));
  }

  for (const [word, quantity] of Object.entries(quantityWords)) {
    if (
      new RegExp(
        `\\b${word}\\s+(?:x\\s*)?(?:pizza[s]?\\s*)?${firstToken}\\b`,
        'i'
      ).test(message)
    ) {
      return quantity;
    }
  }

  return 1;
}

function escapedProductName(product: DeliveryProduct): string {
  return norm(product.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function productsToRemove(
  text: string,
  catalog: DeliveryProduct[]
): DeliveryProduct[] {
  const message = norm(text);

  return catalog.filter(product => {
    const name = escapedProductName(product);

    const direct = new RegExp(
      `(?:tira|tirar|remove|remover|retira|retirar|nao quero mais|não quero mais|cancela)\\s+(?:a|o|uma|um)?\\s*${name}`
    );

    const replace = new RegExp(
      `(?:troca|trocar|substitui|substituir)\\s+(?:a|o|uma|um)?\\s*${name}\\s+(?:por|pela|pelo)`
    );

    return direct.test(message) || replace.test(message);
  });
}

export function parseRating(value: string): number | null {
  const s = stripTrailingPunctuation(value);

  const digit = s.match(
    /^(?:(?:dou|daria|minha nota e|nota)\s+)?([1-5])(?:\s*\/\s*5|[.,]0)?(?:\s+estrelas?)?$/
  );
  if (digit) return Number(digit[1]);

  const words: Record<string, number> = {
    um: 1,
    uma: 1,
    dois: 2,
    duas: 2,
    tres: 3,
    três: 3,
    quatro: 4,
    cinco: 5
  };

  for (const [word, rating] of Object.entries(words)) {
    if (
      new RegExp(
        `^(?:(?:dou|daria|minha nota e|nota)\\s+)?${word}(?:\\s+estrelas?)?$`
      ).test(s)
    ) {
      return rating;
    }
  }

  return null;
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

  const lines = draft.items.map(item => {
    const variation = item.variation ? ` (${item.variation})` : '';
    const notes = item.notes ? ` — ${item.notes}` : '';

    return `• ${item.quantity}x ${item.name}${variation} — ${brl(
      item.unit_price * item.quantity
    )}${notes}`;
  });

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
