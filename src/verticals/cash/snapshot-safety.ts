import type { VerticalContext, VerticalResult } from '../vertical.js';

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function moneyValues(input: string): number[] {
  const values: number[] = [];
  for (const match of String(input ?? '').matchAll(/(?:r\$\s*)?(-?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})|-?\d+(?:[.,]\d{1,2})?)/gi)) {
    const raw = String(match[1] ?? '').trim();
    const normalized = /^-?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(raw)
      ? raw.replace(/\./g, '').replace(',', '.')
      : raw.replace(',', '.');
    const value = Number(normalized);
    if (Number.isFinite(value)) values.push(value);
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

function firstAmountAfter(input: string, pattern: RegExp): number | null {
  const match = String(input ?? '').match(pattern);
  if (!match?.[1]) return null;
  const raw = match[1];
  const normalized = /^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(raw)
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw.replace(',', '.');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function lastCashAmount(input: string): number | null {
  const matches = [...String(input ?? '').matchAll(/\bem caixa\s+(?:tem\s+)?(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})|\d+(?:[.,]\d{1,2})?)/gi)];
  const raw = matches.at(-1)?.[1];
  if (!raw) return null;
  const normalized = /^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(raw)
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw.replace(',', '.');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function withdrawalCount(input: string): number {
  const lines = String(input ?? '').split(/\r?\n+/);
  return lines.filter(line => /\b(retirou|retirei|retirada|saquei|sacou)\b/i.test(line) && /\d/.test(line)).length;
}

export async function handleCashSnapshotSafety(context: VerticalContext): Promise<VerticalResult | null> {
  const input = context.combinedText;
  if (!isCashMixedSnapshotMessage(input)) return null;

  const totalSold = firstAmountAfter(input, /\btotal[^\n]*?vendid\w*[^\d]*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})|\d+(?:[.,]\d{1,2})?)/i);
  const cash = lastCashAmount(input);
  const receivable = firstAmountAfter(input, /\b(?:falta cobrar|a receber)[^\d]*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})|\d+(?:[.,]\d{1,2})?)/i);
  const withdrawals = withdrawalCount(input);

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
