import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const { cashTypingDelayMs } = await import('../src/whatsapp/evolution.client.js');

describe('cash typing effect', () => {
  it('mantém respostas curtas rápidas, mas perceptíveis', () => {
    expect(cashTypingDelayMs('Sim')).toBe(800);
    expect(cashTypingDelayMs('✅ Confirmado! Lançamento registrado.')).toBeGreaterThanOrEqual(800);
  });

  it('aumenta o efeito em respostas maiores sem ultrapassar 1,8s', () => {
    const short = cashTypingDelayMs('Saldo atualizado.');
    const medium = cashTypingDelayMs('Aqui estão os seus lançamentos de hoje organizados para você conferir.');
    const long = cashTypingDelayMs('x'.repeat(1000));

    expect(medium).toBeGreaterThanOrEqual(short);
    expect(long).toBe(1800);
  });
});
