import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const { enrichCashFinancialReport } = await import('../src/verticals/cash/report-position.js');

describe('cash report closing position', () => {
  it('mantém movimentações do período separadas do fechamento do cofrinho', () => {
    const base = [
      '📊 Relatório Semanal',
      '📅 16/08/2026 a 22/08/2026',
      '',
      '💰 Receitas: R$ 0,00',
      '💸 Despesas: R$ 21,87',
      '🏦 Saldo do período: -R$ 21,87',
      '',
      '📂 Por categoria:',
      '- Alimentação: R$ 21,87',
      '',
      'Bom trabalho, Felipe! 💪'
    ].join('\n');

    const output = enrichCashFinancialReport(base, [{
      pocketName: 'vendas',
      referenceDate: '2026-07-31',
      totalSold: 1640,
      cashBalance: 530,
      receivableTotal: 110,
      withdrawalsTotal: 1000,
      withdrawalsCount: 4
    }]);

    expect(output).toContain('💰 Receitas lançadas: R$ 0,00');
    expect(output).toContain('💸 Despesas lançadas: R$ 21,87');
    expect(output).toContain('🏦 Saldo dos lançamentos: -R$ 21,87');
    expect(output).toContain('🐷 *vendas* — ref. 31/07/2026');
    expect(output).toContain('💰 Total vendido: R$ 1.640,00');
    expect(output).toContain('💵 Caixa final: R$ 530,00');
    expect(output).toContain('🧾 A receber: R$ 110,00');
    expect(output).toContain('↗️ Retiradas: 4 · R$ 1.000,00');

    // O fechamento é posição, portanto não pode substituir a receita real do período.
    expect(output).not.toContain('Receitas lançadas: R$ 1.640,00');
  });
});
