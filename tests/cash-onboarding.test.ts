import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const { extractCashOnboardingName } = await import('../src/verticals/cash/access-handler.js');

describe('cash onboarding name', () => {
  it('aceita um nome direto sem pedir novamente', () => {
    expect(extractCashOnboardingName('Stefane')).toBe('Stefane');
  });

  it('entende frase natural de apresentação', () => {
    expect(extractCashOnboardingName('Meu nome é Stefane')).toBe('Stefane');
    expect(extractCashOnboardingName('me chamo João Pedro')).toBe('João Pedro');
  });

  it('deduplica o mesmo nome quando mensagens são agrupadas', () => {
    expect(extractCashOnboardingName('Stefane\nStefane\nMeu nome é Stefane')).toBe('Stefane');
  });

  it('ignora saudação junto do nome no mesmo lote', () => {
    expect(extractCashOnboardingName('Oi\nStefane')).toBe('Stefane');
  });

  it('não confunde lançamento financeiro com nome', () => {
    expect(extractCashOnboardingName('Eu ganhei hoje 600,00\nStefane')).toBe('Stefane');
  });

  it('mantém ambiguidade segura quando existem dois nomes diferentes', () => {
    expect(extractCashOnboardingName('Stefane\nMariana')).toBeNull();
  });
});
