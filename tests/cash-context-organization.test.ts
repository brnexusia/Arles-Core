import { beforeAll, describe, expect, it } from 'vitest';

let parseNaturalPocketNames: (input: string) => string[];
let parsePocketAssignment: (input: string) => any;
let isCashFinancialSnapshot: (input: string) => boolean;
let cashDateFromText: (input: string, from?: Date) => string;
let descriptionFrom: (input: string) => string;

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
  process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
  process.env.EVOLUTION_BASE_URL ||= 'http://127.0.0.1:8080';
  process.env.EVOLUTION_API_KEY ||= 'test';

  const organization = await import('../src/verticals/cash/context-organization.js');
  const parser = await import('../src/verticals/cash/parser.js');
  parseNaturalPocketNames = organization.parseNaturalPocketNames;
  parsePocketAssignment = organization.parsePocketAssignment;
  isCashFinancialSnapshot = organization.isCashFinancialSnapshot;
  cashDateFromText = parser.cashDateFromText;
  descriptionFrom = parser.descriptionFrom;
});

describe('Cash organization context', () => {
  it('entende dois cofrinhos e uma organizacao mensal na mesma mensagem', () => {
    const input = [
      'Quero que você separa por cofrinhos, um cofrinho vai se chamar "Luiza", e coloca outro cofrinho vai se chamar "vendas de roupas".',
      'E registre todas as informações desse mês no cofrinho chamado "Luiza".'
    ].join('\n');

    expect(parseNaturalPocketNames(input)).toEqual(['Luiza', 'vendas de roupas']);
    const assignment = parsePocketAssignment(input);
    expect(assignment?.pocketName).toBe('Luiza');
    expect(assignment?.type).toBe('all');
    expect(assignment?.from).toMatch(/-01$/);
  });

  it('entende pedido direto para colocar gastos do mes no cofrinho', () => {
    const assignment = parsePocketAssignment('Registre os gastos desse mês no cofrinho Luiza');
    expect(assignment?.pocketName).toBe('Luiza');
    expect(assignment?.type).toBe('expense');
  });

  it('reconhece demonstrativo de caixa como snapshot e nao como lista de despesas', () => {
    const input = [
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
    expect(isCashFinancialSnapshot(input)).toBe(true);
  });

  it('nao confunde uma lista real de despesas com snapshot de caixa', () => {
    expect(isCashFinancialSnapshot('Despesas:\nMercado 50\nUber 20\nUnhas 100')).toBe(false);
  });
});

describe('Cash natural weekday dates', () => {
  it('resolve sabado anterior quando hoje e segunda 17/08/2026', () => {
    const monday = new Date('2026-08-17T15:00:00.000Z');
    expect(cashDateFromText('Gastei 26,00 no sábado no cofrinho Luiza', monday)).toBe('2026-08-15');
  });

  it('remove dia da semana e cofrinho da descricao', () => {
    const description = descriptionFrom('Gastei 26,00 no sábado no cofrinho Luiza');
    expect(description.toLowerCase()).not.toContain('sábado');
    expect(description.toLowerCase()).not.toContain('cofrinho');
    expect(description.toLowerCase()).not.toContain('luiza');
  });
});
