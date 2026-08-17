import type { VerticalContext, VerticalResult } from '../vertical.js';

export type CashSnapshotSummary = {
  totalSold: number | null;
  cash: number | null;
  receivable: number | null;
  withdrawals: number;
};

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function parseMoney(raw: string): number | null {
  const clean = String(raw ?? '').replace(/r\$/gi, '').trim();
  const normalized = /^-?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(clean)
    ? clean.replace(/\./g, '').replace(',', '.')
    : clean.replace(',', '.');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function decimalMoneyInLine(line: string): number | null {
  // Datas como 31/07/2026 nunca podem virar dinheiro. Para snapshots livres,
  // só aceitamos valor explícito em reais/decimal (ex.: 1.640,00 ou 530,00).
  const withoutDates = String(line ?? '').replace(/\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/g, ' ');
  const match = withoutDates.match(/(?:r\$\s*)?(-?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})|-?\d+[.,]\d{1,2})/i);
  return match?.[1] ? parseMoney(match[1]) : null;
}

function moneyValues(input: string): number[] {
  const values: number[] = [];
  for (const line of String(input ?? '').split(/\r?\n+/)) {
    const withoutDates = line.replace(/\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/g, ' ');
    for (const match of withoutDates.matchAll(/(?:r\$\s*)?(-?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})|-?\d+[.,]\d{1,2})/gi)) {
      const value = parseMoney(match[1] ?? '');
      if (value != null) values.push(value);
    }
  }
  return values;
}

export function isCashMixedSnapshotMessage(input: string): boolean {
  if (moneyValues(input).length < 3) return false;
  const value = normalize(input);
  const markers = [
    /\btotal\b.*\bvendid\w*/.test(value),
    /\bem caixa\b/.test(value),
    /\b(falta cobrar|a receber|devendo|me deve|esta me devendo)\b/.test(value),
    /\b(retirou|retirei|retirada|saquei|sacou)\b/.test(value)
  ].filter(Boolean).length;
  return markers >= 2;
}

function amountAtOrAfterHeading(input: string, heading: RegExp): number | null {
  const lines = String(input ?? '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!heading.test(normalize(line))) continue;

    const sameLine = decimalMoneyInLine(line);
    if (sameLine != null) return sameLine;

    // O formato comum do WhatsApp é um título em uma linha e o valor logo abaixo.
    // Procuramos no máximo as duas linhas seguintes para não capturar outro bloco.
    for (let offset = 1; offset <= 2 && index + offset < lines.length; offset += 1) {
      const next = String(lines[index + offset] ?? '').trim();
      if (!next) continue;
      const value = decimalMoneyInLine(next);
      if (value != null) return value;
      if (/\b(em caixa|falta cobrar|a receber|retirou|retirada)\b/i.test(next)) break;
    }
  }
  return null;
}

function lastCashAmount(input: string): number | null {
  const lines = String(input ?? '').split(/\r?\n/);
  let last: number | null = null;
  for (const line of lines) {
    if (!/\bem caixa\b/i.test(normalize(line))) continue;
    const value = decimalMoneyInLine(line);
    if (value != null) last = value;
  }
  return last;
}

function withdrawalCount(input: string): number {
  const lines = String(input ?? '').split(/\r?\n+/);
  return lines.filter(line => /\b(retirou|retirei|retirada|saquei|sacou)\b/i.test(line) && decimalMoneyInLine(line) != null).length;
}

export function extractCashSnapshotSummary(input: string): CashSnapshotSummary {
  return {
    totalSold: amountAtOrAfterHeading(input, /\btotal\b.*\bvendid\w*/),
    cash: lastCashAmount(input),
    receivable: amountAtOrAfterHeading(input, /\b(falta cobrar|a receber)\b/),
    withdrawals: withdrawalCount(input)
  };
}

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export async function handleCashSnapshotSafety(context: VerticalContext): Promise<VerticalResult | null> {
  const input = context.combinedText;
  if (!isCashMixedSnapshotMessage(input)) return null;

  const { totalSold, cash, receivable, withdrawals } = extractCashSnapshotSummary(input);

  const lines = [
    'Entendi os dados, mas eles misturam *movimentos* com *saldos/totais*. Então não vou transformar tudo em despesas.',
    ''
  ];
  if (totalSold != null) lines.push(`• Total vendido informado: ${brl(totalSold)}`);
  if (cash != null) lines.push(`• Caixa informado: ${brl(cash)}`);
  if (receivable != null) lines.push(`• Valor a receber: ${brl(receivable)}`);
  if (withdrawals > 0) lines.push(`• Retiradas identificadas: ${withdrawals}`);
  lines.push(
    '',
    '“Em caixa”, “total vendido” e “falta cobrar/devendo” são estados financeiros, não despesas por si só.',
    'As retiradas são movimentos reais; para registrá-las sem inventar data, me diga o período delas (ex.: “essas retiradas foram em julho”).'
  );
  return text(lines.join('\n'));
}
