import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const { deterministicCashParse } = await import('../src/verticals/cash/parser.js');
const { brazilParts, dateIsoOffset } = await import('../src/verticals/cash/time.js');
const { parseCashPocketOrganizationInput } = await import('../src/verticals/cash/pocket-organization.js');
const { isCashMixedSnapshotMessage } = await import('../src/verticals/cash/snapshot-safety.js');

describe('cash screenshot regressions', () => {
  it('classifica pizzaria como alimentação e remove pronome da descrição', () => {
    const result = deterministicCashParse('Ontem eu gastei na pizzaria 5,00');
    expect(result).toMatchObject({
      type: 'expense',
      amount: 5,
      category: 'Alimentação'
    });
    expect(result?.description.toLowerCase()).not.toContain('eu gastei');
  });

  it('resolve sábado para o sábado mais recente e não repete cofrinho na descrição', () => {
    const result = deterministicCashParse('Gastei 26,00 no sábado no cofrinho Luiza');
    const today = brazilParts();
    const delta = (today.weekday - 6 + 7) % 7;
    expect(result?.transactionDate).toBe(dateIsoOffset(-delta));
    expect(result?.description.toLowerCase()).not.toContain('cofrinho');
    expect(result?.description.toLowerCase()).not.toContain('sábado');
  });

  it('entende pedido para separar uma atividade dos gastos pessoais', () => {
    expect(parseCashPocketOrganizationInput(
      'Fiz uma vendagem de roupa e quero que você administra sem mistura com meus gastos pessoais'
    )).toEqual({ kind: 'setup-separation' });
  });

  it('entende criação natural de dois cofrinhos e organização do mês na mesma frase', () => {
    const result = parseCashPocketOrganizationInput([
      'Quero que você separa por cofrinhos, um cofrinho vai se chamar "Luiza",',
      'e coloca outro cofrinho vai se chamar "vendas de roupas".',
      'E registre todas as informações desse mês no cofrinho chamado "Luiza".'
    ].join(' '));

    expect(result).toEqual({
      kind: 'organize',
      createNames: ['Luiza', 'vendas de roupas'],
      pocketName: 'Luiza',
      scope: 'all',
      period: 'current-month'
    });
  });

  it('entende organização de gastos já existentes no cofrinho', () => {
    expect(parseCashPocketOrganizationInput('Registre os gastos desse mês no cofrinho Luiza')).toEqual({
      kind: 'organize',
      createNames: [],
      pocketName: 'Luiza',
      scope: 'expense',
      period: 'current-month'
    });
  });

  it('bloqueia lote que mistura total vendido, caixa, retiradas e valores a receber', () => {
    const message = [
      'Total dos valores vendidos até o dia 31/07/2026',
      '1640,00',
      'Em caixa tem 1530,00',
      '-250,00 Stefane retirou',
      '-250,00 Luiza retirou',
      '-250,00 Stefany retirou',
      '-250,00 Maria retirou',
      'Em caixa tem 530,00',
      'Falta cobrar: 110,00',
      '30,00 Stefane (devendo de Rosana)',
      '80,00 Brenda'
    ].join('\n');

    expect(isCashMixedSnapshotMessage(message)).toBe(true);
    expect(isCashMixedSnapshotMessage('Gastei 50 no mercado e 20 no Uber')).toBe(false);
  });
});
