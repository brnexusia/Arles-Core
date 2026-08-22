import { db } from '../../infrastructure/db.js';
import { formatBrazilDate } from './time.js';

export interface CashClosingPosition {
  pocketName: string;
  referenceDate: string | null;
  totalSold: number | null;
  cashBalance: number | null;
  receivableTotal: number | null;
  withdrawalsTotal: number | null;
  withdrawalsCount: number;
}

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Retorna a última posição conhecida de cada cofrinho.
 *
 * Fechamento é um snapshot/estado, não uma movimentação. Por isso ele não deve ser
 * somado em cash_transactions nem limitado ao período do relatório. O relatório
 * mostra o período das movimentações e, separadamente, a posição mais recente dos
 * cofrinhos com sua própria data de referência.
 */
export async function loadCashClosingPositions(companyId: string): Promise<CashClosingPosition[]> {
  const result = await db.query<{
    pocket_name: string;
    reference_date: string | null;
    total_sold: number | null;
    cash_balance: number | null;
    receivable_total: number | null;
    withdrawals_total: number | null;
    withdrawals_count: number | null;
  }>(
    `select distinct on (s.pocket_id)
       p.name as pocket_name,
       s.reference_date::text,
       s.total_sold::float8,
       s.cash_balance::float8,
       s.receivable_total::float8,
       s.withdrawals_total::float8,
       s.withdrawals_count::int
     from cash_pocket_snapshots s
     join cash_pockets p on p.id=s.pocket_id and p.company_id=s.company_id
     where s.company_id=$1 and p.active=true
     order by s.pocket_id,s.reference_date desc nulls last,s.created_at desc
     limit 12`,
    [companyId]
  );

  return result.rows.map(row => ({
    pocketName: String(row.pocket_name || 'Cofrinho'),
    referenceDate: row.reference_date ? String(row.reference_date).slice(0, 10) : null,
    totalSold: numberOrNull(row.total_sold),
    cashBalance: numberOrNull(row.cash_balance),
    receivableTotal: numberOrNull(row.receivable_total),
    withdrawalsTotal: numberOrNull(row.withdrawals_total),
    withdrawalsCount: Number(row.withdrawals_count || 0)
  }));
}

function closingBlock(positions: CashClosingPosition[]): string {
  const lines: string[] = [
    '📦 *Posição dos cofrinhos*',
    'Último fechamento conhecido de cada cofrinho:'
  ];

  for (const position of positions) {
    lines.push('');
    lines.push(`🐷 *${position.pocketName}*${position.referenceDate ? ` — ref. ${formatBrazilDate(position.referenceDate)}` : ''}`);
    if (position.totalSold != null) lines.push(`💰 Total vendido: ${brl(position.totalSold)}`);
    if (position.cashBalance != null) lines.push(`💵 Caixa final: ${brl(position.cashBalance)}`);
    if (position.receivableTotal != null) lines.push(`🧾 A receber: ${brl(position.receivableTotal)}`);
    if (position.withdrawalsTotal != null && position.withdrawalsTotal > 0) {
      lines.push(`↗️ Retiradas: ${position.withdrawalsCount} · ${brl(position.withdrawalsTotal)}`);
    }
  }

  lines.push('');
  lines.push('ℹ️ Fechamentos são posição de caixa e ficam separados dos lançamentos para não duplicar valores.');
  return lines.join('\n');
}

function clarifyMovementLabels(value: string): string {
  return value
    .replace(/💰 Receitas:/g, '💰 Receitas lançadas:')
    .replace(/💸 Despesas:/g, '💸 Despesas lançadas:')
    .replace(/💰 Entradas:/g, '💰 Entradas lançadas:')
    .replace(/💸 Saídas:/g, '💸 Saídas lançadas:')
    .replace(/🏦 Saldo do período:/g, '🏦 Saldo dos lançamentos:')
    .replace(/🏦 Saldo:/g, '🏦 Saldo dos lançamentos:');
}

/**
 * Enriquece resumo/relatório sem alterar a matemática do período.
 * Insere a posição dos cofrinhos antes da despedida quando houver uma.
 */
export function enrichCashFinancialReport(
  baseText: string,
  positions: CashClosingPosition[]
): string {
  if (!positions.length) return baseText;

  const clarified = clarifyMovementLabels(baseText);
  const block = closingBlock(positions);
  const farewellIndex = clarified.lastIndexOf('\n\nBom trabalho');

  if (farewellIndex >= 0) {
    return `${clarified.slice(0, farewellIndex)}\n\n${block}${clarified.slice(farewellIndex)}`;
  }
  return `${clarified}\n\n${block}`;
}
