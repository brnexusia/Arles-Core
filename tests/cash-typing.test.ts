import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const { cashTypingDelayMs, EVOLUTION_WEBHOOK_EVENTS } = await import('../src/whatsapp/evolution.client.js');
const { normalizeEvolutionPresence } = await import('../src/whatsapp/normalize.js');
const { cashSilenceRemainingMs } = await import('../src/whatsapp/cash-timing.js');

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

  it('mantém a janela inteira em 5s enquanto o lead está digitando', () => {
    expect(cashSilenceRemainingMs({
      lastActivityAt: 1_000,
      now: 4_900,
      silenceMs: 5_000,
      typing: true
    })).toBe(5_000);
  });

  it('reinicia 5s quando o lead para e reinicia novamente se voltar a digitar', () => {
    // Parou de digitar agora: nova janela completa.
    expect(cashSilenceRemainingMs({
      lastActivityAt: 10_000,
      now: 10_000,
      silenceMs: 5_000,
      typing: false
    })).toBe(5_000);

    // Dois segundos de silêncio consumiram apenas 2s da janela.
    expect(cashSilenceRemainingMs({
      lastActivityAt: 10_000,
      now: 12_000,
      silenceMs: 5_000,
      typing: false
    })).toBe(3_000);

    // Voltou a digitar: a janela volta imediatamente para 5s completos.
    expect(cashSilenceRemainingMs({
      lastActivityAt: 12_000,
      now: 14_000,
      silenceMs: 5_000,
      typing: true
    })).toBe(5_000);

    // Parou novamente: mais uma nova janela completa de 5s.
    expect(cashSilenceRemainingMs({
      lastActivityAt: 14_000,
      now: 14_000,
      silenceMs: 5_000,
      typing: false
    })).toBe(5_000);
  });

  it('considera uma nova mensagem como nova atividade e só libera após 5s de silêncio', () => {
    const secondMessageAt = 20_000;

    expect(cashSilenceRemainingMs({
      lastActivityAt: secondMessageAt,
      now: secondMessageAt,
      silenceMs: 5_000,
      typing: false
    })).toBe(5_000);

    expect(cashSilenceRemainingMs({
      lastActivityAt: secondMessageAt,
      now: secondMessageAt + 4_999,
      silenceMs: 5_000,
      typing: false
    })).toBe(1);

    expect(cashSilenceRemainingMs({
      lastActivityAt: secondMessageAt,
      now: secondMessageAt + 5_000,
      silenceMs: 5_000,
      typing: false
    })).toBe(0);
  });
});
