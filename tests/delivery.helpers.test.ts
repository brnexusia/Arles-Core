import { describe, expect, it } from 'vitest';
import {
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
  isRejection,
  isThanks,
  parseRating,
  productsToRemove,
  quantityForProduct,
  singleConfiguredFee,
  stageForDraft
} from '../src/verticals/delivery/helpers.js';

const catalog = [
  {
    id: '1',
    name: 'Pizza Vegetariana',
    category: 'Pizzas',
    description: '',
    price: 35,
    variations: []
  },
  {
    id: '2',
    name: 'Pizza Calabresa',
    category: 'Pizzas',
    description: '',
    price: 38,
    variations: []
  },
  {
    id: '3',
    name: 'Coca-Cola 2L',
    category: 'Bebidas',
    description: '',
    price: 14,
    variations: []
  }
];

describe('linguagem natural do delivery', () => {
  it('aceita confirmações naturais sem aceitar agradecimento', () => {
    for (const value of [
      'sim', 'simm', 'siim', 'sssimm', 'sim!', 's', 'ss',
      'claro', 'com certeza', 'aham', 'uhum', 'pode',
      'pode confirmar', 'pode preparar', 'isso aí', 'certinho',
      'beleza', 'show', 'bora', 'manda ver'
    ]) {
      expect(isConfirmation(value), value).toBe(true);
    }

    for (const value of ['obrigado', 'valeu', 'bom dia', 'quanto custa?']) {
      expect(isConfirmation(value), value).toBe(false);
    }
  });

  it('entende recusas e pedido de ajuste', () => {
    for (const value of ['não', 'nao', 'nn', 'espera aí', 'não confirma', 'quero mudar']) {
      expect(isRejection(value), value).toBe(true);
    }
    expect(isRejection('sim')).toBe(false);
  });

  it('entende entrega e retirada com variações', () => {
    for (const value of ['entrega', 'manda aqui', 'pode entregar', 'receber em casa']) {
      expect(detectDeliveryType(value), value).toBe('delivery');
    }

    for (const value of ['retirada', 'vou buscar', 'pego no local', 'passo aí']) {
      expect(detectDeliveryType(value), value).toBe('pickup');
    }
  });

  it('entende pagamento com variações', () => {
    for (const value of ['pix', 'vou de pix', 'pago no pix']) {
      expect(detectPayment(value), value).toBe('pix');
    }

    for (const value of ['dinheiro', 'em espécie', 'pago em dinheiro']) {
      expect(detectPayment(value), value).toBe('cash');
    }

    for (const value of ['cartão', 'crédito', 'débito', 'maquininha', 'cartão na entrega']) {
      expect(detectPayment(value), value).toBe('card');
    }
  });

  it('entende que não precisa de troco', () => {
    for (const value of ['não', 'sem troco', 'valor exato', 'não precisa', 'troco não']) {
      expect(isNoChange(value), value).toBe(true);
    }
  });

  it('reconhece pedidos de cardápio e saudações', () => {
    expect(isMenuRequest('me manda o cardápio')).toBe(true);
    expect(isMenuRequest('quais opções vocês têm?')).toBe(true);
    expect(isGreeting('oiii')).toBe(true);
    expect(isGreeting('boa noite')).toBe(true);
  });

  it('reconhece agradecimentos pós-pedido', () => {
    expect(isThanks('obg')).toBe(true);
    expect(isThanks('valeu')).toBe(true);
    expect(isThanks('tmj')).toBe(true);
  });

  it('extrai nome sem confundir comando de pedido', () => {
    expect(extractName('meu nome é Felipe Gloria')).toBe('Felipe Gloria');
    expect(extractName('pode me chamar de Ana')).toBe('Ana');
    expect(extractName('manda uma vegetariana')).toBe('');
    expect(extractName('pix')).toBe('');
  });

  it('identifica necessidade de transbordo', () => {
    expect(handoffReason('quero falar com um atendente')).toBeTruthy();
    expect(handoffReason('cadê meu pedido?')).toBeTruthy();
    expect(handoffReason('quero cancelar meu pedido')).toBeTruthy();
    expect(handoffReason('quero adicionar no pedido', true)).toBeTruthy();
  });

  it('reconhece nota de avaliação de formas naturais', () => {
    expect(parseRating('5')).toBe(5);
    expect(parseRating('nota 4')).toBe(4);
    expect(parseRating('cinco')).toBe(5);
    expect(parseRating('dou quatro')).toBe(4);
    expect(parseRating('nota 10')).toBeNull();
    expect(parseRating('quero 5 coca')).toBeNull();
  });
});

describe('catálogo e pedido determinístico', () => {
  it('encontra produto real pelo nome', () => {
    const matches = findProductsInMessage('manda uma vegetariana', catalog);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe('1');
  });

  it('entende quantidade numérica e por extenso', () => {
    expect(quantityForProduct('manda 3 calabresa', catalog[1]!)).toBe(3);
    expect(quantityForProduct('manda duas vegetariana', catalog[0]!)).toBe(2);
  });

  it('remove produto somente com comando explícito', () => {
    expect(productsToRemove('tira a Pizza Vegetariana', catalog).map(p => p.id)).toContain('1');
    expect(productsToRemove('troca a Pizza Calabresa por vegetariana', catalog).map(p => p.id)).toContain('2');
  });

  it('só aceita taxa configurada com um número', () => {
    expect(singleConfiguredFee('R$ 5,00')).toBe(5);
    expect(singleConfiguredFee('R$ 5 a R$ 10')).toBeNull();
  });

  it('state machine segue a ordem do checkout', () => {
    const draft = emptyDraft();
    expect(stageForDraft(draft)).toBe('idle');

    draft.items.push({
      product_id: '1',
      name: 'Pizza Vegetariana',
      quantity: 1,
      variation: '',
      unit_price: 35,
      notes: ''
    });
    expect(stageForDraft(draft)).toBe('waiting_name');

    draft.client_name = 'Felipe';
    expect(stageForDraft(draft)).toBe('waiting_delivery_type');

    draft.delivery_type = 'delivery';
    expect(stageForDraft(draft)).toBe('waiting_address');

    draft.delivery_address = 'Rua X, 110';
    expect(stageForDraft(draft)).toBe('waiting_payment');

    draft.payment_method = 'cash';
    expect(stageForDraft(draft)).toBe('waiting_change');

    draft.change_for = 50;
    draft.delivery_fee = 5;
    expect(stageForDraft(draft)).toBe('waiting_confirmation');
  });
});
