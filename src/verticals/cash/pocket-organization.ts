import { db } from '../../infrastructure/db.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashPocketService } from './cofrinhos.js';
import {
  currentMonthWindow,
  currentWeekWindow,
  dateIsoOffset,
  isoBrazil,
  previousMonthWindow,
  previousWeekWindow
} from './time.js';

type PocketScope = 'expense' | 'income' | 'all';
type PocketPeriod = 'today' | 'yesterday' | 'current-week' | 'previous-week' | 'current-month' | 'previous-month';

export type CashPocketOrganizationIntent =
  | { kind: 'setup-separation' }
  | {
      kind: 'organize';
      createNames: string[];
      pocketName: string | null;
      scope: PocketScope | null;
      period: PocketPeriod | null;
    }
  | null;

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function cleanName(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/^["'“”]+|["'“”.,!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

function addName(target: string[], value: string): void {
  const name = cleanName(value);
  if (name.length < 2) return;
  const key = normalize(name);
  if (target.some(item => normalize(item) === key)) return;
  target.push(name);
}

/**
 * Entende frases naturais como:
 * “um cofrinho vai se chamar Luiza e outro vai se chamar vendas de roupas”.
 * Os comandos curtos tradicionais continuam sendo tratados por cofrinhos.ts.
 */
export function extractNaturalPocketNames(input: string): string[] {
  const names: string[] = [];
  const source = String(input ?? '');
  const pattern = /\bcofrinho\s+(?:vai\s+se\s+chamar|vai\s+chamar|chamad[oa])\s+["'“”]?([^"'“”\n,.;!?]+)["'“”]?/gi;
  for (const match of source.matchAll(pattern)) addName(names, match[1] ?? '');
  return names;
}

function targetPocketName(input: string): string | null {
  const source = String(input ?? '');
  const match = source.match(/\b(?:no|na|para\s+o|pro|ao)\s+cofrinho(?:\s+chamad[oa])?\s+["'“”]?([^"'“”\n,.;!?]+)["'“”]?/i);
  return match?.[1] ? cleanName(match[1]) : null;
}

function scopeFrom(input: string): PocketScope | null {
  const value = normalize(input);
  if (/\b(gastos?|despesas?|saidas?|retiradas?)\b/.test(value)) return 'expense';
  if (/\b(receitas?|entradas?|recebimentos?|ganhos?)\b/.test(value)) return 'income';
  if (/\b(informacoes?|lancamentos?|registros?|movimentacoes?)\b/.test(value)) return 'all';
  return null;
}

function periodFrom(input: string): PocketPeriod | null {
  const value = normalize(input);
  if (/\bontem\b/.test(value)) return 'yesterday';
  if (/\bhoje\b/.test(value)) return 'today';
  if (/\b(semana passada|ultima semana)\b/.test(value)) return 'previous-week';
  if (/\b(esta semana|essa semana|semana atual|dessa semana|desta semana)\b/.test(value)) return 'current-week';
  if (/\b(mes passado|ultimo mes)\b/.test(value)) return 'previous-month';
  if (/\b(este mes|esse mes|mes atual|desse mes|deste mes)\b/.test(value)) return 'current-month';
  return null;
}

function isSetupSeparation(input: string): boolean {
  const value = normalize(input);
  const wantsOrganization = /\b(separ|organiz|administr|gerenci|control)\w*/.test(value)
    || /\bsem\s+mistur\w*/.test(value);
  const personal = /\b(gastos? pessoais?|financas? pessoais?|pessoal)\b/.test(value);
  const parallelActivity = /\b(venda|vendas|vendagem|negocio|empresa|trabalho|roupa|roupas|loja)\w*/.test(value);
  return wantsOrganization && personal && parallelActivity;
}

export function parseCashPocketOrganizationInput(input: string): CashPocketOrganizationIntent {
  const createNames = extractNaturalPocketNames(input);
  const pocketName = targetPocketName(input);
  const scope = scopeFrom(input);
  const period = periodFrom(input);
  const value = normalize(input);
  const wantsAssignment = /\b(registr|coloc|jog|mov|pass|vincul|separ|organiz)\w*/.test(value)
    && Boolean(pocketName)
    && Boolean(scope)
    && Boolean(period);

  if (createNames.length || wantsAssignment) {
    return { kind: 'organize', createNames, pocketName, scope, period };
  }
  if (isSetupSeparation(input)) return { kind: 'setup-separation' };
  return null;
}

function windowFor(period: PocketPeriod): { from: string; to: string } {
  if (period === 'today') {
    const day = isoBrazil();
    return { from: day, to: day };
  }
  if (period === 'yesterday') {
    const day = dateIsoOffset(-1);
    return { from: day, to: day };
  }
  if (period === 'current-week') return currentWeekWindow();
  if (period === 'previous-week') return previousWeekWindow();
  if (period === 'previous-month') return previousMonthWindow();
  return currentMonthWindow();
}

function scopeLabel(scope: PocketScope): string {
  if (scope === 'expense') return 'gastos';
  if (scope === 'income') return 'receitas';
  return 'lançamentos';
}

async function assignExistingTransactions(
  companyId: string,
  pocketId: string,
  scope: PocketScope,
  period: PocketPeriod
): Promise<{ matched: number; changed: number }> {
  const window = windowFor(period);
  const type = scope === 'all' ? null : scope;
  const matchedResult = await db.query<{ count: number }>(
    `select count(*)::int as count
     from cash_transactions
     where company_id=$1
       and transaction_date between $2::date and $3::date
       and ($4::text is null or type=$4)`,
    [companyId, window.from, window.to, type]
  );
  const matched = Number(matchedResult.rows[0]?.count ?? 0);

  const changedResult = await db.query(
    `update cash_transactions
     set pocket_id=$2,updated_at=now()
     where company_id=$1
       and transaction_date between $3::date and $4::date
       and ($5::text is null or type=$5)
       and pocket_id is distinct from $2
     returning id`,
    [companyId, pocketId, window.from, window.to, type]
  );

  return { matched, changed: Number(changedResult.rowCount ?? 0) };
}

export async function handleCashPocketOrganization(context: VerticalContext): Promise<VerticalResult | null> {
  const intent = parseCashPocketOrganizationInput(context.combinedText);
  if (!intent) return null;

  if (intent.kind === 'setup-separation') {
    return text([
      'Consigo separar essa atividade dos seus gastos pessoais 👍',
      'A forma mais segura é usar um cofrinho só para ela. Os lançamentos continuam no seu saldo geral, mas ficam organizados separadamente.',
      '',
      'Você pode dizer: “criar cofrinho Vendas de roupas” e depois mandar os valores normalmente.'
    ].join('\n'));
  }

  const created: string[] = [];
  for (const name of intent.createNames) {
    const result = await cashPocketService.create(context.company.id, name);
    if (result.created) created.push(result.pocket.name);
  }

  if (intent.pocketName && intent.scope && intent.period) {
    const pocket = await cashPocketService.findByName(context.company.id, intent.pocketName);
    if (!pocket) {
      return text(`Não encontrei o cofrinho *${intent.pocketName}*. Crie primeiro com “criar cofrinho ${intent.pocketName}”.`);
    }

    const moved = await assignExistingTransactions(context.company.id, pocket.id, intent.scope, intent.period);
    const lines: string[] = [];
    if (created.length) lines.push(`🐷 Cofrinhos criados: ${created.map(name => `*${name}*`).join(', ')}.`);

    if (!moved.matched) {
      lines.push(`Não encontrei ${scopeLabel(intent.scope)} nesse período para colocar no cofrinho *${pocket.name}*.`);
    } else if (!moved.changed) {
      lines.push(`Os ${moved.matched} ${scopeLabel(intent.scope)} desse período já estavam no cofrinho *${pocket.name}*.`);
    } else {
      lines.push(`✅ Coloquei ${moved.changed} de ${moved.matched} ${scopeLabel(intent.scope)} desse período no cofrinho *${pocket.name}*.`);
    }
    return text(lines.join('\n'));
  }

  if (created.length) {
    return text([
      `🐷 ${created.length === 1 ? 'Cofrinho criado' : 'Cofrinhos criados'}: ${created.map(name => `*${name}*`).join(', ')}.`,
      'Agora você pode registrar movimentos neles ou pedir para organizar lançamentos de um período.'
    ].join('\n'));
  }

  return null;
}
