import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashPocketService } from './cofrinhos.js';
import { cashLedgerService, type CashProjection } from './ledger.js';

function resultText(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function calculate(base: number, projection: CashProjection): number {
  return Math.round(projection.operations.reduce((balance, operation) =>
    operation.type === 'income' ? balance + operation.amount : balance - operation.amount,
  base) * 100) / 100;
}

export async function executeCashProjection(
  context: VerticalContext,
  projection: CashProjection
): Promise<VerticalResult> {
  const pocketRef = await cashPocketService.findMentioned(context.company.id, context.combinedText);
  if (pocketRef.explicit && !pocketRef.pocket) {
    const name = pocketRef.requestedName || 'informado';
    return resultText(`Não encontrei o cofrinho *${name}*. Mande “meus cofrinhos” para conferir os nomes.`);
  }

  const snapshot = projection.explicitBase == null
    ? await cashLedgerService.snapshot(context.company.id, pocketRef.pocket?.id ?? null)
    : null;
  const base = projection.explicitBase ?? snapshot?.balance ?? 0;
  const projected = calculate(base, projection);
  const operations = projection.operations.map(operation =>
    `${operation.type === 'income' ? '➕' : '➖'} ${brl(operation.amount)}`
  );

  return resultText([
    `🧮 *Simulação de saldo${pocketRef.pocket ? ` — ${pocketRef.pocket.name}` : ''}*`,
    `Saldo usado: ${brl(base)}`,
    ...operations,
    `Saldo projetado: *${brl(projected)}*`,
    '',
    'Não registrei nenhum lançamento — foi só uma simulação.'
  ].join('\n'));
}
