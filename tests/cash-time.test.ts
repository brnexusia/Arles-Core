import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const {
  formatBrazilDate,
  isoBrazil,
  nextMondayAt8Brazil,
  nextFirstOfMonthAt8Brazil,
  previousWeekWindow,
  previousMonthWindow
} = await import('../src/verticals/cash/time.js');

describe('cash Brazil time', () => {
  it('usa UTC-3 na virada do dia', () => {
    expect(isoBrazil(new Date('2026-08-16T01:30:00Z'))).toBe('2026-08-15');
  });

  it('formata DATE do PostgreSQL apenas como DD/MM/AAAA', () => {
    expect(formatBrazilDate('2026-08-15')).toBe('15/08/2026');
    expect(formatBrazilDate(new Date('2026-08-15T00:00:00.000Z'))).toBe('15/08/2026');
    expect(formatBrazilDate(String(new Date('2026-08-15T00:00:00.000Z')))).toBe('15/08/2026');
  });

  it('agenda segunda-feira às 08:00 de Brasília', () => {
    const run = nextMondayAt8Brazil(new Date('2026-08-15T18:00:00Z'));
    expect(run.toISOString()).toBe('2026-08-17T11:00:00.000Z');
  });

  it('agenda o relatório mensal no próprio dia 1 se ainda não deu 08:00', () => {
    const run = nextFirstOfMonthAt8Brazil(new Date('2026-09-01T10:00:00Z'));
    expect(run.toISOString()).toBe('2026-09-01T11:00:00.000Z');
  });

  it('calcula semana e mês anteriores completos', () => {
    expect(previousWeekWindow(new Date('2026-08-17T12:00:00Z'))).toEqual({
      from: '2026-08-10',
      to: '2026-08-16'
    });
    expect(previousMonthWindow(new Date('2026-09-01T12:00:00Z'))).toEqual({
      from: '2026-08-01',
      to: '2026-08-31'
    });
  });
});
