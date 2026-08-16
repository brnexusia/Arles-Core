import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const {
  expandQueryFollowup,
  isGuideRequest,
  isUndoRequest,
  shouldRememberCashQuery,
  toIsoDateOnly
} = await import('../src/verticals/cash/conversation.js');

describe('cash conversational layer', () => {
  it('mantém o contexto da consulta e troca apenas o período', () => {
    expect(expandQueryFollowup('Quanto gastei hoje?', 'E ontem?')).toBe('Quanto gastei ontem?');
    expect(expandQueryFollowup('Quanto gastei na SHEIN esse mês?', 'E ontem?')).toBe('Quanto gastei na SHEIN ontem?');
    expect(expandQueryFollowup('quais foram meus gastos hoje?', 'E ontem')).toBe('quais foram meus gastos ontem');
  });

  it('memoriza consulta mesmo quando a lista compacta usa o formato de clipboard', () => {
    const result = {
      actions: [{
        type: 'text' as const,
        text: '📋 Hoje:\n• mercado — R$ 80,00 · 16/08/2026'
      }]
    };
    expect(shouldRememberCashQuery('quais foram meus gastos hoje?', result)).toBe(true);
  });

  it('não memoriza fallback como se fosse consulta válida', () => {
    const result = {
      actions: [{
        type: 'text' as const,
        text: 'Hmm, não entendi bem 🤔'
      }]
    };
    expect(shouldRememberCashQuery('quais foram meus gastos hoje?', result)).toBe(false);
  });

  it('reconhece pedido natural para desfazer exclusão', () => {
    expect(isUndoRequest('Coloca ele de novo')).toBe(true);
    expect(isUndoRequest('desfaz')).toBe(true);
  });

  it('reconhece guia e comandos em linguagem natural', () => {
    expect(isGuideRequest('ajuda')).toBe(true);
    expect(isGuideRequest('guia de ajuda')).toBe(true);
    expect(isGuideRequest('como funciona?')).toBe(true);
  });

  it('converte Date para data pura sem hora ou timezone', () => {
    expect(toIsoDateOnly(new Date('2026-08-15T00:00:00.000Z'))).toBe('2026-08-15');
    expect(toIsoDateOnly('Sat Aug 15 2026 00:00:00 GMT+0000 (Coordinated Universal Time)')).toBe('2026-08-15');
  });
});
