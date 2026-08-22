import { db } from '../../infrastructure/db.js';
import type { VerticalResult } from '../vertical.js';
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
    `select latest.pocket_name,latest.reference_date,latest.total_sold,latest.cash_balance,
            latest.receivable_total,latest.withdrawals_total,latest.withdrawals_count
     from (
       select distinct on (s.pocket_id)
         p.name as pocket_name,
         s.reference_date::text as reference_date,
         s.total_sold::float8 as total_sold,
         s.cash_balance::float8 as cash_balance,
         s.receivable_total::float8 as receivable_total,
         s.withdrawals_total::float8 as withdrawals_total,
         s.withdrawals_count::int as withdrawals_count,
         s.created_at,
         coalesce(s.reference_date,timezone('America/Sao_Paulo',s.created_at)::date) as effective_date
       from cash_pocket_snapshots s
       join cash_pockets p on p.id=s.pocket_id and p.company_id=s.company_id
       where s.company_id=$1 and p.active=true
       order by s.pocket_id,
                coalesce(s.reference_date,timezone('America/Sao_Paulo',s.created_at)::date) desc,
                s.created_at desc
     ) latest
     order by latest.effective_date desc,latest.created_at desc,latest.pocket_name asc
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
  if (!positions.length || baseText.includes('📦 *Posição dos cofrinhos*')) return baseText;

  const clarified = clarifyMovementLabels(baseText);
  const block = closingBlock(positions);
  const farewellIndex = clarified.lastIndexOf('\n\nBom trabalho');

  if (farewellIndex >= 0) {
    return `${clarified.slice(0, farewellIndex)}\n\n${block}${clarified.slice(farewellIndex)}`;
  }
  return `${clarified}\n\n${block}`;
}

/**
 * Saldo direto também precisa deixar claro que snapshots de caixa existem, mas sem
 * incorporá-los aritmeticamente ao ledger de lançamentos. Só enriquece respostas de
 * saldo/resumo; confirmações e demais mensagens não são alteradas.
 */
export async function enrichCashBalanceResult(
  companyId: string,
  result: VerticalResult | null
): Promise<VerticalResult | null> {
  if (!result) return result;
  const hasTarget = result.actions.some(action =>
    action.type === 'text' && (
      action.text.trimStart().startsWith('💰 *Seu dinheiro agora*') ||
      action.text.trimStart().startsWith('📊 ')
    )
  );
  if (!hasTarget) return result;

  const positions = await loadCashClosingPositions(companyId);
  if (!positions.length) return result;

  return {
    ...result,
    actions: result.actions.map(action => action.type === 'text'
      ? { ...action, text: enrichCashFinancialReport(action.text, positions) }
      : action)
  };
}
