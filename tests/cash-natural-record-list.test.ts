import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const { isCashNaturalRecordListRequest } = await import('../src/verticals/cash/ai-first-handler.js');

describe('cash natural record list', () => {
  it('trata pedidos naturais de registros como consulta direta', () => {
    for (const input of [
      'Fala meus registros aí',
      'Me mostra meus registros',
      'Lista meus lançamentos',
      'Traz meus registros pra mim',
      'Quais são meus registros?'
    ]) {
      expect(isCashNaturalRecordListRequest(input), input).toBe(true);
    }
  });

  it('não confunde pedido de ajuda com execução da consulta', () => {
    expect(isCashNaturalRecordListRequest('Como vejo meus registros?')).toBe(false);
    expect(isCashNaturalRecordListRequest('Me ensina a consultar meus registros')).toBe(false);
  });
});
