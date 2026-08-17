import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const { parseCashReportRequest, cashReportWindow } = await import('../src/verticals/cash/report-context.js');

const NOW = new Date('2026-08-17T14:00:00.000Z'); // 11:00 em America/Sao_Paulo, segunda-feira

describe('cash report context', () => {
  it('entende pedido natural de resumo semanal como semana atual', () => {
    const request = parseCashReportRequest('Me manda o resumo da semana');
    expect(request).toEqual({ kind: 'weekly', period: 'current' });
    expect(cashReportWindow(request!, NOW)).toEqual({
      from: '2026-08-17',
      to: '2026-08-17'
    });
  });

  it('usa a semana passada quando o usuário continua o relatório anterior', () => {
    const request = parseCashReportRequest('Da semana passada', 'weekly');
    expect(request).toEqual({ kind: 'weekly', period: 'previous' });
    expect(cashReportWindow(request!, NOW)).toEqual({
      from: '2026-08-10',
      to: '2026-08-16'
    });
  });

  it('entende relatório da semana passada em uma única mensagem', () => {
    const request = parseCashReportRequest('Me manda o relatório da semana passada');
    expect(request).toEqual({ kind: 'weekly', period: 'previous' });
    expect(cashReportWindow(request!, NOW)).toEqual({
      from: '2026-08-10',
      to: '2026-08-16'
    });
  });

  it('entende variações de semana atual e passada', () => {
    expect(parseCashReportRequest('resumo da última semana')).toEqual({ kind: 'weekly', period: 'previous' });
    expect(parseCashReportRequest('fechamento da semana anterior')).toEqual({ kind: 'weekly', period: 'previous' });
    expect(parseCashReportRequest('relatório semanal')).toEqual({ kind: 'weekly', period: 'current' });
    expect(parseCashReportRequest('dessa semana', 'weekly')).toEqual({ kind: 'weekly', period: 'current' });
  });

  it('mantém contexto equivalente para relatório mensal', () => {
    const current = parseCashReportRequest('Me manda o resumo do mês');
    expect(current).toEqual({ kind: 'monthly', period: 'current' });
    expect(cashReportWindow(current!, NOW)).toEqual({
      from: '2026-08-01',
      to: '2026-08-17'
    });

    const previous = parseCashReportRequest('Do mês passado', 'monthly');
    expect(previous).toEqual({ kind: 'monthly', period: 'previous' });
    expect(cashReportWindow(previous!, NOW)).toEqual({
      from: '2026-07-01',
      to: '2026-07-31'
    });
  });

  it('entende pedido mensal completo com período anterior', () => {
    expect(parseCashReportRequest('relatório do mês passado')).toEqual({ kind: 'monthly', period: 'previous' });
    expect(parseCashReportRequest('fechamento do mês anterior')).toEqual({ kind: 'monthly', period: 'previous' });
  });

  it('não transforma período solto em relatório sem contexto anterior', () => {
    expect(parseCashReportRequest('da semana passada')).toBeNull();
    expect(parseCashReportRequest('do mês passado')).toBeNull();
  });

  it('não sequestra consultas financeiras que apenas citam um período', () => {
    expect(parseCashReportRequest('quanto gastei na semana passada?')).toBeNull();
    expect(parseCashReportRequest('quanto recebi no mês passado?')).toBeNull();
  });
});
