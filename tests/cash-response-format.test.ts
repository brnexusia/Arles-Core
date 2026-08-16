import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const {
  cleanCashListItemLabel,
  formatCashCompactListText
} = await import('../src/verticals/cash/response-format.js');

describe('cash compact response formatter', () => {
  it('remove frase longa, categoria visual e data repetida de cada linha', () => {
    const raw = [
      '📋 Hoje:',
      '• E com os outros eu comprei uns itens, objetos, comprei também uma acaraje, xarope e me sobrou — R$ 80,00 · 16/08/2026',
      '• paguei uma parcela da bicicleta — R$ 100,00 · 16/08/2026',
      '• paguei unhas — R$ 100,00 · 16/08/2026',
      '• Eu guardei — R$ 300,00 · 16/08/2026'
    ].join('\n');

    expect(formatCashCompactListText(raw, 'quais foram meus gastos hoje?')).toBe([
      'Seus gastos de hoje foram:',
      '',
      'Acaraje, xarope — R$ 80,00',
      'Parcela da bicicleta — R$ 100,00',
      'Unhas — R$ 100,00',
      'Reserva — R$ 300,00'
    ].join('\n'));
  });

  it('usa o período apenas no título', () => {
    const raw = [
      '📋 Ontem:',
      '• mercado — R$ 6,60 · 15/08/2026',
      '• lanche — R$ 7,49 · 15/08/2026'
    ].join('\n');

    const result = formatCashCompactListText(raw, 'quais foram meus gastos ontem?');
    expect(result).toBe('Seus gastos de ontem foram:\n\nMercado — R$ 6,60\nLanche — R$ 7,49');
    expect(result).not.toContain('15/08/2026');
  });

  it('mantém receitas com título correto', () => {
    const raw = '📋 Hoje:\n• salário — R$ 2.000,00 · 16/08/2026';
    expect(formatCashCompactListText(raw, 'quais foram minhas receitas hoje?')).toBe(
      'Suas receitas de hoje foram:\n\nSalário — R$ 2.000,00'
    );
  });

  it('encurta descrições antigas comuns', () => {
    expect(cleanCashListItemLabel('paguei uma parcela da bicicleta')).toBe('Parcela da bicicleta');
    expect(cleanCashListItemLabel('paguei unhas')).toBe('Unhas');
    expect(cleanCashListItemLabel('Eu guardei')).toBe('Reserva');
  });
});
