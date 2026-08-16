import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const { cashTypingDelayMs, EVOLUTION_WEBHOOK_EVENTS } = await import('../src/whatsapp/evolution.client.js');
const { normalizeEvolutionPresence } = await import('../src/whatsapp/normalize.js');

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

  it('assina PRESENCE_UPDATE no webhook da Evolution', () => {
    expect(EVOLUTION_WEBHOOK_EVENTS).toContain('PRESENCE_UPDATE');
    expect(EVOLUTION_WEBHOOK_EVENTS).toContain('MESSAGES_UPSERT');
  });

  it('normaliza presença composing e paused do usuário', () => {
    const composing = normalizeEvolutionPresence({
      event: 'presence.update',
      instance: 'arles-cash',
      data: {
        id: '5575999999999@s.whatsapp.net',
        presences: {
          '5575999999999@s.whatsapp.net': { lastKnownPresence: 'composing' }
        }
      }
    });

    expect(composing).toEqual({
      instanceName: 'arles-cash',
      phone: '5575999999999',
      presence: 'composing'
    });

    const paused = normalizeEvolutionPresence({
      event: 'PRESENCE_UPDATE',
      instance: 'arles-cash',
      data: {
        id: '5575999999999@s.whatsapp.net',
        presences: {
          '5575999999999@s.whatsapp.net': { lastKnownPresence: 'paused' }
        }
      }
    });

    expect(paused?.presence).toBe('paused');
  });

  it('prefere o JID real dentro de presences quando o id externo é LID', () => {
    const normalized = normalizeEvolutionPresence({
      event: 'presence.update',
      instance: 'arles-cash',
      data: {
        id: '123456789@lid',
        presences: {
          '5575888888888@s.whatsapp.net': { lastKnownPresence: 'composing' }
        }
      }
    });

    expect(normalized?.phone).toBe('5575888888888');
  });
});
