import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('Arles Cash — contrato do executor tipado', () => {
  it('não volta ao parser textual para totais, consultas ou último lote', () => {
    const router = source('src/verticals/cash/deterministic-language.ts');

    expect(router).toContain('executeCashFinancialSummary(context, intent.aggregate)');
    expect(router).toContain('executeCashQueryFilters(context.company.id, intent.query)');
    expect(router).toContain('executeCashRecentBatchReference(context, recentIntent)');

    expect(router).not.toContain('cashQuery.handle(context.company.id, intent.canonical)');
    expect(router).not.toContain('handleCashFinancialSummary({ ...context, combinedText: intent.canonical })');
    expect(router).not.toContain('handleCashRecentBatchReference(context)');
  });

  it('mantém adaptadores textuais apenas como compatibilidade, separados dos executores tipados', () => {
    const summary = source('src/verticals/cash/financial-summary.ts');
    const recent = source('src/verticals/cash/recent-batch.ts');
    const query = source('src/verticals/cash/query-filter-executor.ts');

    expect(summary).toContain('export async function executeCashFinancialSummary');
    expect(summary).toContain('export async function handleCashFinancialSummary');
    expect(recent).toContain('export async function executeCashRecentBatchReference');
    expect(recent).toContain('export async function handleCashRecentBatchReference');
    expect(query).toContain('export async function executeCashQueryFilters');
    expect(query).not.toContain('OpenAI');
  });
});
