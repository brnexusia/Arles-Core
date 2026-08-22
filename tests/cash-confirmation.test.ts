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

describe('cash registration compatibility', () => {
  it('mantém leitura de confirmações antigas durante a migração', () => {
    expect(isCashRegistrationConfirmation('sim')).toBe(true);
    expect(isCashRegistrationConfirmation('pode registrar')).toBe(true);
    expect(isCashRegistrationConfirmation('isso mesmo')).toBe(true);
    expect(isCashRegistrationConfirmation('tá certo')).toBe(true);
  });

  it('mantém cancelamento legado sem confundir conversa comum', () => {
    expect(isCashRegistrationCancellation('não')).toBe(true);
    expect(isCashRegistrationCancellation('cancela')).toBe(true);
    expect(isCashRegistrationCancellation('não registra')).toBe(true);
    expect(isCashRegistrationConfirmation('quanto gastei hoje?')).toBe(false);
    expect(isCashRegistrationConfirmation('edita o valor')).toBe(false);
  });

  it('mantém parser de edição de estado antigo', () => {
    expect(isCashRegistrationEditRequest('editar')).toBe(true);
    expect(isCashRegistrationEditRequest('editar 2 valor 80')).toBe(true);
    expect(isCashRegistrationEditRequest('categoria Reserva')).toBe(true);
    expect(parseCashEditPatch('editar 2 valor 80')).toMatchObject({ amount: 80 });
    expect(parseCashEditPatch('item 1 categoria Reserva')).toMatchObject({ category: 'Reserva' });
  });

  it('confirma o salvamento sem pedir uma segunda mensagem ao usuário', () => {
    expect(cashRegistrationSavedMessage(1)).toBe('✅ Lançamento registrado.');
    expect(cashRegistrationSavedMessage(4)).toBe('✅ 4 lançamentos registrados.');
    expect(cashRegistrationSavedMessage(4)).not.toContain('R$');
    expect(cashRegistrationSavedMessage(4)).not.toContain('📂');
    expect(cashRegistrationSavedMessage(4)).not.toContain('📅');
  });
});
