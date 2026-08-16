import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const {
  isCashRegistrationConfirmation,
  isCashRegistrationCancellation,
  isCashRegistrationEditRequest,
  cashRegistrationSavedMessage
} = await import('../src/verticals/cash/confirmation.js');
const { parseCashEditPatch } = await import('../src/verticals/cash/management.js');

describe('cash confirmation', () => {
  it('aceita confirmações naturais para registrar', () => {
    expect(isCashRegistrationConfirmation('sim')).toBe(true);
    expect(isCashRegistrationConfirmation('pode registrar')).toBe(true);
    expect(isCashRegistrationConfirmation('isso mesmo')).toBe(true);
    expect(isCashRegistrationConfirmation('tá certo')).toBe(true);
  });

  it('aceita cancelamento e nunca confunde conversa comum com confirmação', () => {
    expect(isCashRegistrationCancellation('não')).toBe(true);
    expect(isCashRegistrationCancellation('cancela')).toBe(true);
    expect(isCashRegistrationCancellation('não registra')).toBe(true);
    expect(isCashRegistrationConfirmation('quanto gastei hoje?')).toBe(false);
    expect(isCashRegistrationConfirmation('edita o valor')).toBe(false);
  });

  it('reconhece edição do resumo pendente', () => {
    expect(isCashRegistrationEditRequest('editar')).toBe(true);
    expect(isCashRegistrationEditRequest('editar 2 valor 80')).toBe(true);
    expect(isCashRegistrationEditRequest('categoria Reserva')).toBe(true);
    expect(parseCashEditPatch('editar 2 valor 80')).toMatchObject({ amount: 80 });
    expect(parseCashEditPatch('item 1 categoria Reserva')).toMatchObject({ category: 'Reserva' });
  });

  it('confirma sem repetir os itens já revisados', () => {
    expect(cashRegistrationSavedMessage(1)).toBe('✅ Confirmado! Lançamento registrado.');
    expect(cashRegistrationSavedMessage(4)).toBe('✅ Confirmado! 4 lançamentos registrados.');
    expect(cashRegistrationSavedMessage(4)).not.toContain('R$');
    expect(cashRegistrationSavedMessage(4)).not.toContain('📂');
    expect(cashRegistrationSavedMessage(4)).not.toContain('📅');
  });
});
