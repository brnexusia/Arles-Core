import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const { cashHelpMessage, cashHelpSection } = await import('../src/verticals/cash/help.js');

describe('cash help por seções', () => {
  it('mostra apenas o índice no pedido genérico', () => {
    expect(cashHelpSection('ajuda')).toBe('menu');
    const message = cashHelpMessage('menu');
    expect(message).toContain('1️⃣ Registrar');
    expect(message).toContain('3️⃣ Criar e usar cofrinhos');
    expect(message).toContain('6️⃣ Planos');
    expect(message).not.toContain('gastei 50 no mercado');
  });

  it('abre a seção de registro sem despejar o guia inteiro', () => {
    expect(cashHelpSection('ajuda registrar')).toBe('register');
    const message = cashHelpMessage('register');
    expect(message).toContain('gastei 50 no mercado');
    expect(message).not.toContain('Relatórios e resumos');
  });

  it('entende ajuda natural de consulta', () => {
    expect(cashHelpSection('como consulto meus gastos?')).toBe('query');
    expect(cashHelpMessage('query')).toContain('quanto gastei hoje?');
  });

  it('entende ajuda natural de cofrinhos', () => {
    expect(cashHelpSection('como uso cofrinhos?')).toBe('pockets');
    expect(cashHelpMessage('pockets')).toContain('criar cofrinho Emprego');
  });

  it('aceita número da seção', () => {
    expect(cashHelpSection('3')).toBe('pockets');
    expect(cashHelpSection('opção 4')).toBe('manage');
    expect(cashHelpSection('5')).toBe('reports');
    expect(cashHelpSection('opção 6')).toBe('plans');
  });
});
