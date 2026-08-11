import { describe, expect, it } from 'vitest';
import {
  detectDeliveryType,
  detectPayment,
  emptyDraft,
  isConfirmation,
  singleConfiguredFee,
  stageForDraft
} from '../src/verticals/delivery/helpers.js';

describe('delivery helpers', () => {
  it('reconhece confirmação explícita', () => {
    expect(isConfirmation('sim')).toBe(true);
    expect(isConfirmation('simm')).toBe(true);
    expect(isConfirmation('siim')).toBe(true);
    expect(isConfirmation('sssimm')).toBe(true);
    expect(isConfirmation('sim!')).toBe(true);
    expect(isConfirmation('claro')).toBe(true);
    expect(isConfirmation('pode confirmar')).toBe(true);
    expect(isConfirmation('obrigado')).toBe(false);
  });

  it('reconhece entrega e retirada', () => {
    expect(detectDeliveryType('Vai ser entrega')).toBe('delivery');
    expect(detectDeliveryType('Vou retirar aí')).toBe('pickup');
  });

  it('reconhece pagamento', () => {
    expect(detectPayment('pix')).toBe('pix');
    expect(detectPayment('cartão de débito')).toBe('card');
    expect(detectPayment('dinheiro')).toBe('cash');
  });

  it('só aceita taxa configurada com um número', () => {
    expect(singleConfiguredFee('R$ 5,00')).toBe(5);
    expect(singleConfiguredFee('R$ 5 a R$ 10')).toBeNull();
  });

  it('state machine começa pelos itens', () => {
    const draft = emptyDraft();
    expect(stageForDraft(draft)).toBe('idle');

    draft.items.push({
      product_id: '1',
      name: 'Vegetariana',
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

    draft.payment_method = 'pix';
    draft.delivery_fee = 5;

    expect(stageForDraft(draft)).toBe('waiting_confirmation');
  });
});
