import { db } from '../../infrastructure/db.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashPocketService } from './cofrinhos.js';

export interface CashLedgerSnapshot {
  income: number;
  expense: number;
  balance: number;
  count: number;
}

export interface CashProjectionOperation {
  type: 'income' | 'expense';
  amount: number;
}

export interface CashProjection {
  explicitBase: number | null;
  operations: CashProjectionOperation[];
}

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function money(raw: string): number | null {
  const clean = String(raw ?? '').trim();
  const normalized = /^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(clean)
    ? clean.replace(/\./g, '').replace(',', '.')
    : clean.replace(',', '.');
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : null;
}

const MONEY = '(\\d{1,3}(?:\\.\\d{3})+(?:,\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';

function explicitBaseBalance(input: string): number | null {
  const value = normalize(input);
  const patterns = [
    new RegExp(`\\b(?:tenho|estou com|to com|tô com)\\s+(?:um\\s+)?saldo\\s+(?:de\\s+)?(?:r\\$\\s*)?${MONEY}`),
    new RegExp(`\\bmeu saldo(?: atual)?\\s+(?:e|é|esta|está|fica)?\\s*(?:em|de)?\\s*(?:r\\$\\s*)?${MONEY}`),
    new RegExp(`\\bsaldo(?: atual)?\\s+(?:e|é|de|igual a)\\s*(?:r\\$\\s*)?${MONEY}`),
    new RegExp(`\\b(?:partindo|parto|começando|comecando)\\s+(?:de|com)\\s*(?:um\\s+)?saldo\\s+(?:de\\s+)?(?:r\\$\\s*)?${MONEY}`),
    new RegExp(`\\b(?:considera|considere|usa|use)\\s+(?:um\\s+)?saldo\\s+(?:de\\s+)?(?:r\\$\\s*)?${MONEY}`)
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const amount = match?.[1] ? money(match[1]) : null;
    if (amount != null) return amount;
  }
  return null;
}

function operationMatches(input: string): Array<{ index: number; operation: CashProjectionOperation }> {
  const value = normalize(input);
  const patterns: Array<{ type: 'income' | 'expense'; regex: RegExp }> = [
    {
      type: 'expense',
      regex: new RegExp(`\\b(?:se|caso|quando|e se)?\\s*(?:eu\\s+)?(?:for\\s+)?(?:gastar|gaste|gastasse|pagar|pague|pagasse|comprar|compre|comprasse|usar|use|usasse|tirar|retirar|descontar)\\s+(?:mais\\s+)?(?:r\\$\\s*)?${MONEY}`, 'g')
    },
    {
      type: 'expense',
      regex: new RegExp(`\\b(?:vou|irei|pretendo)\\s+(?:gastar|pagar|comprar|usar)\\s+(?:r\\$\\s*)?${MONEY}`, 'g')
    },
    {
      type: 'expense',
      regex: new RegExp(`\\bse\\s+(?:sair|sairam|sairem|debitar|descontar)\\s+(?:r\\$\\s*)?${MONEY}`, 'g')
    },
    {
      type: 'income',
      regex: new RegExp(`\\b(?:se|caso|quando|e se)?\\s*(?:eu\\s+)?(?:for\\s+)?(?:receber|receba|recebesse|ganhar|ganhe|ganhasse|entrar|cair|depositarem|vender)\\s+(?:mais\\s+)?(?:r\\$\\s*)?${MONEY}`, 'g')
    },
    {
      type: 'income',
      regex: new RegExp(`\\b(?:vou|irei|pretendo)\\s+(?:receber|ganhar|faturar)\\s+(?:r\\$\\s*)?${MONEY}`, 'g')
    },
    {
      type: 'income',
      regex: new RegExp(`\\bse\\s+(?:entrar|cair)\\s+(?:r\\$\\s*)?${MONEY}`, 'g')
    }
  ];

  const found: Array<{ index: number; operation: CashProjectionOperation }> = [];
  for (const item of patterns) {
    item.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = item.regex.exec(value)) !== null) {
      const raw = match[1];
      const amount = raw ? money(raw) : null;
      if (amount != null && amount > 0) {
        found.push({ index: match.index, operation: { type: item.type, amount } });
      }
      if (match[0].length === 0) item.regex.lastIndex += 1;
    }
  }

  const unique = new Map<string, { index: number; operation: CashProjectionOperation }>();
  for (const item of found) {
    const key = `${item.index}:${item.operation.type}:${item.operation.amount}`;
    unique.set(key, item);
  }
  return [...unique.values()].sort((a, b) => a.index - b.index);
}

export function isCashHypotheticalOrCalculation(input: string): boolean {
  const value = normalize(input);
  if (!value) return false;
  if (/\b(simula|simular|simulacao|simulação|hipoteticamente|supondo|imaginando|faria uma conta|faz a conta|calcula|calcular)\b/.test(value)) return true;
  if (/\b(se|caso|e se)\b/.test(value) && /\b(?:gast\w*|pag\w*|compr\w*|receb\w*|ganh\w*|entr\w*|cai\w*|sai\w*|sobr\w*|rest\w*|fic\w*|saldo)\b/.test(value)) return true;
  if (/\b(quanto|qual)\b.*\b(ficaria|fica|sobraria|sobra|restaria|resta|teria|terei|vai sobrar|vai ficar)\b/.test(value)) return true;
  if (/\b(?:vou|irei|pretendo)\s+(?:gastar|pagar|comprar|receber|ganhar)\b/.test(value) && /\b(quanto|saldo|sobra|fica|ficaria)\b/.test(value)) return true;
  if (/\b(?:saldo|tenho)\b.*\b(?:menos|mais)\b\s*(?:r\$\s*)?\d/.test(value)) return true;
  return false;
}

export function parseCashProjection(input: string): CashProjection | null {
  if (!isCashHypotheticalOrCalculation(input)) return null;
  const operations = operationMatches(input).map(item => item.operation);

  if (!operations.length) {
    const value = normalize(input);
    const minus = value.match(new RegExp(`\\b(?:menos|tirando|descontando)\\s+(?:r\\$\\s*)?${MONEY}`));
    const plus = value.match(new RegExp(`\\b(?:mais|somando|adicionando)\\s+(?:r\\$\\s*)?${MONEY}`));
    const minusAmount = minus?.[1] ? money(minus[1]) : null;
    const plusAmount = plus?.[1] ? money(plus[1]) : null;
    if (minusAmount && minusAmount > 0) operations.push({ type: 'expense', amount: minusAmount });
    if (plusAmount && plusAmount > 0) operations.push({ type: 'income', amount: plusAmount });
  }

  if (!operations.length) return null;
  return { explicitBase: explicitBaseBalance(input), operations };
}

export function isCashDirectBalanceRequest(input: string): boolean {
  const value = normalize(input).replace(/[!?.,]+$/g, '').trim();
  if (!value || isCashHypotheticalOrCalculation(value) || /\bcofrinho\b/.test(value)) return false;

  const exact = /^(?:me diz |me fala |fala |mostra |mostre |diz )?(?:meu |o meu )?(?:saldo|saldo atual|saldo disponivel|saldo disponível|balanco|balanço)(?: agora| hoje)?$/;
  if (exact.test(value)) return true;

  return /\b(quanto eu tenho|quanto tenho|quanto que eu tenho|quanto que tenho|quanto tem|quanto que tem|quanto sobrou|quanto que sobrou|quanto me resta|quanto resta|quanto tenho disponivel|quanto tenho disponível|qual e meu saldo|qual é meu saldo|como esta meu saldo|como está meu saldo|meu dinheiro agora|quanto tenho de dinheiro|quanto ficou meu saldo)\b/.test(value);
}

export function isCashForecastLanguage(input: string): boolean {
  const value = normalize(input);
  if (!value) return false;

  // Recorrência explícita é sempre previsão, nunca lançamento já realizado.
  if (/\b(todo dia|todos os dias|toda semana|todo mes|todo mês|todo ano|diariamente|semanalmente|mensalmente|anualmente|a cada\s+\d+\s+(?:dias|semanas|meses|anos))\b/.test(value)) return true;
  if (/\b(agend\w*|program\w*|previs\w*|previst\w*|saldo projetado|contas futuras)\b/.test(value)) return true;

  // Futuro pontual com verbo de dinheiro: “amanhã vou pagar 100”.
  const futureTime = /\b(amanha|depois de amanha|daqui a\s+\d+\s+dias?|no dia\s+\d{1,2}|dia\s+\d{1,2}[\/-]\d{1,2})\b/.test(value);
  const futureVerb = /\b(?:vou|irei|pretendo)\s+(?:gast\w*|pag\w*|compr\w*|receb\w*|ganh\w*|fatur\w*)\b/.test(value);
  return futureTime && futureVerb;
}

export function isCashProtectedNonTransaction(input: string): boolean {
  const value = normalize(input);
  if (!value) return false;
  if (isCashForecastLanguage(value)) return true;
  if (isCashHypotheticalOrCalculation(value) || isCashDirectBalanceRequest(value)) return true;
  if (/\?$/.test(String(input).trim()) && /\b(quanto|qual|quais|como|se|saldo|sobr|rest|ficaria|teria)\b/.test(value)) return true;
  if (/\b(nao registra|não registra|sem registrar|so calcula|só calcula|apenas calcula|e uma simulacao|é uma simulação)\b/.test(value)) return true;
  return false;
}

export class CashLedgerService {
  async snapshot(companyId: string, pocketId?: string | null): Promise<CashLedgerSnapshot> {
    const result = await db.query(
      `select
         coalesce(sum(amount) filter(where type='income'),0)::float8 as income,
         coalesce(sum(amount) filter(where type='expense'),0)::float8 as expense,
         (coalesce(sum(amount) filter(where type='income'),0)-
          coalesce(sum(amount) filter(where type='expense'),0))::float8 as balance,
         count(*)::int as count
       from cash_transactions
       where company_id=$1
         and ($2::uuid is null or pocket_id=$2::uuid)`,
      [companyId, pocketId ?? null]
    );
    return {
      income: Number(result.rows[0]?.income ?? 0),
      expense: Number(result.rows[0]?.expense ?? 0),
      balance: Number(result.rows[0]?.balance ?? 0),
      count: Number(result.rows[0]?.count ?? 0)
    };
  }

  async availability(companyId: string): Promise<{ total: number; pockets: number; available: number }> {
    const [snapshot, pocketRows] = await Promise.all([
      this.snapshot(companyId),
      cashPocketService.list(companyId)
    ]);
    const pockets = round(pocketRows.reduce((sum, pocket) => sum + Number(pocket.balance), 0));
    return {
      total: round(snapshot.balance),
      pockets,
      available: round(snapshot.balance - pockets)
    };
  }
}

export const cashLedgerService = new CashLedgerService();

function projectionResult(base: number, projection: CashProjection): number {
  return Math.round(projection.operations.reduce((saldo, operation) => {
    return operation.type === 'income' ? saldo + operation.amount : saldo - operation.amount;
  }, base) * 100) / 100;
}

export async function handleCashLedgerDeterministic(context: VerticalContext): Promise<VerticalResult | null> {
  const projection = parseCashProjection(context.combinedText);
  if (projection) {
    const pocketRef = await cashPocketService.findMentioned(context.company.id, context.combinedText);
    if (pocketRef.explicit && !pocketRef.pocket && pocketRef.requestedName) {
      return text(`Não encontrei o cofrinho *${pocketRef.requestedName}*. Mande “meus cofrinhos” para conferir os nomes.`);
    }

    let base: number;
    let baseLabel = 'Saldo usado';
    if (projection.explicitBase != null) {
      base = projection.explicitBase;
    } else if (pocketRef.pocket) {
      const pocketBalance = await cashPocketService.balance(context.company.id, pocketRef.pocket.id);
      base = pocketBalance.balance;
      baseLabel = `Saldo do cofrinho ${pocketRef.pocket.name}`;
    } else if (/\b(disponivel|saldo livre|livre para gastar|fora dos cofrinhos|sem mexer nos cofrinhos)\b/.test(normalize(context.combinedText))) {
      const availability = await cashLedgerService.availability(context.company.id);
      base = availability.available;
      baseLabel = 'Disponível fora dos cofrinhos';
    } else {
      base = (await cashLedgerService.snapshot(context.company.id)).balance;
    }

    const result = projectionResult(base, projection);
    const operations = projection.operations.map(operation =>
      `${operation.type === 'income' ? '➕' : '➖'} ${brl(operation.amount)}`
    );
    return text([
      `🧮 *Simulação de saldo${pocketRef.pocket ? ` — ${pocketRef.pocket.name}` : ''}*`,
      `${baseLabel}: ${brl(base)}`,
      ...operations,
      `Saldo projetado: *${brl(result)}*`,
      '',
      'Não registrei nenhum lançamento — foi só uma simulação.'
    ].join('\n'));
  }

  if (isCashDirectBalanceRequest(context.combinedText)) {
    const [snapshot, availability] = await Promise.all([
      cashLedgerService.snapshot(context.company.id),
      cashLedgerService.availability(context.company.id)
    ]);
    return text([
      '💰 *Seu dinheiro agora*',
      `Disponível fora dos cofrinhos: *${brl(availability.available)}*`,
      availability.pockets !== 0 ? `Guardado nos cofrinhos: ${brl(availability.pockets)}` : '',
      `Saldo total: ${brl(availability.total)}`,
      `Entradas acumuladas: ${brl(snapshot.income)}`,
      `Saídas acumuladas: ${brl(snapshot.expense)}`,
      '',
      'O saldo total considera todos os lançamentos. O disponível desconta o que está separado nos cofrinhos.'
    ].filter(Boolean).join('\n'));
  }

  return null;
}
