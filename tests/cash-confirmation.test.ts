import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const {
  isCashRegistrationConfirmation,
  isCashRegistrationCancellation
} = await import('../src/verticals/cash/confirmation.js');

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
});
