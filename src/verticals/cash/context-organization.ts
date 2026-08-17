import { db } from '../../infrastructure/db.js';
import { redis } from '../../infrastructure/redis.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import {
  cashPocketService,
  normalizeCashPocketName,
  parseCashPocketCommand,
  parseCashPocketCreateNames
} from './cofrinhos.js';
import {
  currentMonthWindow,
  currentWeekWindow,
  dateIsoOffset,
  isoBrazil,
  previousMonthWindow,
  previousWeekWindow
} from './time.js';

const CONTEXT_TTL_SECONDS = 30 * 60;

type PocketContext = { ids: string[]; names: string[] };
type PocketAssignment = {
  pocketName: string;
  type: 'income' | 'expense' | 'all';
  from: string;
  to: string;
};

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

function phoneDigits(value: string): string {
  return String(value ?? '').replace(/\D/g, '');
}

function pocketContextKey(companyId: string, phone: string): string {
  return `arles:cash:pocket-context:${companyId}:${phoneDigits(phone)}`;
}

async function savePocketContext(companyId: string, phone: string, pockets: Array<{ id: string; name: string }>): Promise<void> {
  const unique = new Map<string, { id: string; name: string }>();
  for (const pocket of pockets) unique.set(String(pocket.id), { id: String(pocket.id), name: String(pocket.name) });
  const values = [...unique.values()];
  if (!values.length) {
    await redis.del(pocketContextKey(companyId, phone));
    return;
  }
  const payload: PocketContext = { ids: values.map(item => item.id), names: values.map(item => item.name) };
  await redis.set(pocketContextKey(companyId, phone), JSON.stringify(payload), 'EX', CONTEXT_TTL_SECONDS);
}

async function getPocketContext(companyId: string, phone: string): Promise<PocketContext | null> {
  const raw = await redis.get(pocketContextKey(companyId, phone));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PocketContext;
    if (!Array.isArray(parsed.ids) || !Array.isArray(parsed.names) || parsed.ids.length !== parsed.names.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

function cleanPocketName(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/^["'“”]+|["'“”.,!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

export function parseNaturalPocketNames(input: string): string[] {
  const source = String(input ?? '');
  const names = [...parseCashPocketCreateNames(source)];
  const patterns = [
    /\b(?:um|outro|mais um)\s+cofrinho\s+(?:vai\s+se\s+chamar|vai\s+chamar|se\s+chama)\s+["'“”]?([^"'“”\n,;.]+)["'“”]?/gi,
    /\b(?:um|outro|mais um)\s+cofrinho\s+chamado\s+["'“”]?([^"'“”\n,;.]+)["'“”]?/gi
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const name = cleanPocketName(match[1] ?? '');
      if (!name || name.length < 2) continue;
      const key = normalizeCashPocketName(name);
      if (!names.some(existing => normalizeCashPocketName(existing) === key)) names.push(name);
      if (!match[0].length) pattern.lastIndex += 1;
    }
  }
  return names;
}

function extractPocketNameAtEnd(input: string): string | null {
  const match = String(input ?? '').match(/\bcofrinho\s+(?:chamad[oa]\s+)?["'“”]?([^"'“”\n,.!?;]+)["'“”]?\s*[.!?]*$/i);
  const name = cleanPocketName(match?.[1] ?? '');
  return name.length >= 2 ? name : null;
}

function periodFrom(input: string): { from: string; to: string } {
  const value = normalize(input);
  if (/\b(ontem)\b/.test(value)) {
    const day = dateIsoOffset(-1);
    return { from: day, to: day };
  }
  if (/\b(hoje)\b/.test(value)) {
    const day = isoBrazil();
    return { from: day, to: day };
  }
  if (/\b(semana passada|ultima semana)\b/.test(value)) return previousWeekWindow();
  if (/\b(essa semana|esta semana|dessa semana|desta semana|semana atual)\b/.test(value)) return currentWeekWindow();
  if (/\b(mes passado|mês passado|ultimo mes|último mês)\b/.test(value)) return previousMonthWindow();
  return currentMonthWindow();
}

export function parsePocketAssignment(input: string): PocketAssignment | null {
  const value = normalize(input);
  const pocketName = extractPocketNameAtEnd(input);
  if (!pocketName) return null;

  const action = /\b(registr|coloc|mov|jog|organiz|separ|pass|vincul|associ)\w*/.test(value);
  const records = /\b(gastos?|despesas?|saidas?|entradas?|receitas?|ganhos?|registros?|lancamentos?|movimentacoes?|informacoes?)\b/.test(value);
  if (!action || !records) return null;

  const type: PocketAssignment['type'] = /\b(gastos?|despesas?|saidas?)\b/.test(value)
    ? 'expense'
    : /\b(entradas?|receitas?|ganhos?)\b/.test(value)
      ? 'income'
      : 'all';
  const period = periodFrom(input);
  return { pocketName, type, ...period };
}

function hasDeleteVerb(value: string): boolean {
  return /\b(apag|exclu|remov|delet|tir)\w*/.test(value);
}

function isPocketPronounDelete(input: string): boolean {
  const value = normalize(input);
  return hasDeleteVerb(value)
    && /\b(ele|ela|esse|essa|este|esta|isso)\b/.test(value)
    && !/\b(registro|lancamento|gasto|despesa|receita|compra)\b/.test(value);
}

function explicitPocketDeleteName(input: string): string | null {
  const value = normalize(input);
  if (!hasDeleteVerb(value) || !/\bcofrinho\b/.test(value)) return null;
  const match = String(input ?? '').match(/\bcofrinho\s+(?:chamad[oa]\s+)?["'“”]?([^"'“”\n,.!?;]+)["'“”]?\s*[.!?]*$/i);
  return cleanPocketName(match?.[1] ?? '') || null;
}

async function removePocket(companyId: string, pocketId: string, pocketName: string): Promise<VerticalResult> {
  const countResult = await db.query<{ count: number }>(
    'select count(*)::int as count from cash_transactions where company_id=$1 and pocket_id=$2',
    [companyId, pocketId]
  );
  const count = Number(countResult.rows[0]?.count ?? 0);
  if (count > 0) {
    return text([
      `⚠️ O cofrinho *${pocketName}* tem ${count} lançamento${count === 1 ? '' : 's'}.`,
      'Não removi para não perder a organização desses registros.',
      `Se quiser reorganizar antes, diga por exemplo: “coloca os gastos deste mês no cofrinho Outro”.`
    ].join('\n'));
  }
  await db.query('update cash_pockets set active=false,updated_at=now() where company_id=$1 and id=$2', [companyId, pocketId]);
  return text(`🗑️ Cofrinho *${pocketName}* removido. Nenhum lançamento financeiro foi apagado.`);
}

export function isCashFinancialSnapshot(input: string): boolean {
  const value = normalize(input);
  const moneyCount = String(input ?? '').match(/(?:r\$\s*)?-?\d+(?:\.\d{3})*(?:[.,]\d{1,2})?/gi)?.length ?? 0;
  if (moneyCount < 3) return false;
  const markers = [
    /\bem caixa\b/,
    /\bfalta cobrar\b/,
    /\btotal (?:dos )?valores? vendidos?\b/,
    /\bretirou\b/,
    /\bdevendo\b/
  ];
  return markers.filter(marker => marker.test(value)).length >= 2;
}

function money(raw: string): number | null {
  const clean = String(raw ?? '').replace(/^[-+]\s*/, '').trim();
  const normalized = /^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(clean)
    ? clean.replace(/\./g, '').replace(',', '.')
    : clean.replace(',', '.');
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : null;
}

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function financialSnapshotMessage(input: string): string {
  const lines = String(input ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  let sold: number | null = null;
  const cashValues: number[] = [];
  let receivableTotal: number | null = null;
  const withdrawals: Array<{ name: string; amount: number }> = [];
  const debtors: Array<{ name: string; amount: number; note?: string }> = [];
  let awaitingSoldValue = false;
  let afterReceivableHeader = false;

  for (const line of lines) {
    const norm = normalize(line);
    if (/total (?:dos )?valores? vendidos?/.test(norm)) {
      const same = line.match(/(-?\d+(?:\.\d{3})*(?:[.,]\d{1,2})?)/);
      if (same?.[1]) sold = money(same[1]);
      else awaitingSoldValue = true;
      continue;
    }
    if (awaitingSoldValue) {
      const raw = line.match(/^-?\s*(\d+(?:\.\d{3})*(?:[.,]\d{1,2})?)$/)?.[1];
      if (raw) sold = money(raw);
      awaitingSoldValue = false;
      if (raw) continue;
    }

    const cash = line.match(/\bem caixa\s+(?:tem|tinha|ficou|fica)?\s*:?[\sR$]*(-?\d+(?:\.\d{3})*(?:[.,]\d{1,2})?)/i);
    if (cash?.[1]) {
      const amount = money(cash[1]);
      if (amount != null) cashValues.push(amount);
      continue;
    }

    const withdrawal = line.match(/^-?\s*(\d+(?:\.\d{3})*(?:[.,]\d{1,2})?)\s+(.+?)\s+retirou\b/i);
    if (withdrawal?.[1] && withdrawal[2]) {
      const amount = money(withdrawal[1]);
      if (amount != null) withdrawals.push({ name: cleanPocketName(withdrawal[2]), amount });
      continue;
    }

    const receivable = line.match(/\bfalta\s+cobrar\s*:?[\sR$]*(\d+(?:\.\d{3})*(?:[.,]\d{1,2})?)/i);
    if (receivable?.[1]) {
      receivableTotal = money(receivable[1]);
      afterReceivableHeader = true;
      continue;
    }

    if (afterReceivableHeader) {
      const debtor = line.match(/^(\d+(?:\.\d{3})*(?:[.,]\d{1,2})?)\s+(.+)$/);
      if (debtor?.[1] && debtor[2]) {
        const amount = money(debtor[1]);
        if (amount != null) debtors.push({ name: cleanPocketName(debtor[2]), amount });
      }
    }
  }

  const output = ['📒 *Entendi como um resumo financeiro/caixa*', ''];
  if (sold != null) output.push(`🧾 Total vendido informado: ${brl(sold)}`);
  if (cashValues.length) output.push(`💵 Caixa atual informado: *${brl(cashValues[cashValues.length - 1]!)}*`);
  if (withdrawals.length) {
    output.push(`↘️ Retiradas informadas: ${brl(withdrawals.reduce((sum, item) => sum + item.amount, 0))}`);
    output.push(...withdrawals.map(item => `• ${item.name}: ${brl(item.amount)}`));
  }
  if (receivableTotal != null) output.push(`🧾 A receber informado: *${brl(receivableTotal)}*`);
  if (debtors.length) output.push(...debtors.map(item => `• ${item.name}: ${brl(item.amount)}`));
  output.push('', 'Não transformei saldos de caixa, totais vendidos ou valores a receber em despesas.', 'Se quiser organizar esse histórico, diga em qual cofrinho ele pertence e quais linhas são movimentações reais.');
  return output.join('\n');
}

function isFutureDataStatement(input: string): boolean {
  const value = normalize(input);
  return /\b(?:ainda\s+)?(?:vou|irei)\s+(?:enviar|mandar|passar|informar)\b/.test(value)
    && /\b(devendo|deve|caixa|saldo|vendas?|gastos?|informacoes?)\b/.test(value);
}

function isSeparationIntent(input: string): boolean {
  const value = normalize(input);
  return /\b(venda|vendagem|negocio|loja|roupa|operacao)\w*/.test(value)
    && /\b(separ|sem mistur|nao mistur|administ|organiz)\w*/.test(value)
    && !/\bcofrinho\b/.test(value);
}

async function applyAssignment(context: VerticalContext, assignment: PocketAssignment): Promise<VerticalResult> {
  const pocket = await cashPocketService.findByName(context.company.id, assignment.pocketName);
  if (!pocket) return text(`Não encontrei o cofrinho *${assignment.pocketName}*. Crie ele primeiro ou mande “meus cofrinhos”.`);

  const result = await db.query(
    `update cash_transactions
     set pocket_id=$2
     where company_id=$1
       and transaction_date between $3::date and $4::date
       and ($5::text='all' or type=$5)
     returning id`,
    [context.company.id, pocket.id, assignment.from, assignment.to, assignment.type]
  );
  const count = Number(result.rowCount ?? 0);
  await savePocketContext(context.company.id, context.message.phone, [pocket]);
  const label = assignment.type === 'expense' ? 'gastos' : assignment.type === 'income' ? 'entradas' : 'lançamentos';
  return text(count
    ? `🐷 Organizei ${count} ${label} no cofrinho *${pocket.name}*. Valores, tipos e datas não foram alterados.`
    : `Não encontrei ${label} nesse período para colocar no cofrinho *${pocket.name}*.`);
}

export async function rememberCashPocketContext(context: VerticalContext): Promise<void> {
  const names = parseNaturalPocketNames(context.combinedText);
  if (names.length) {
    const pockets = (await Promise.all(names.map(name => cashPocketService.findByName(context.company.id, name))))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (pockets.length) await savePocketContext(context.company.id, context.message.phone, pockets);
    return;
  }

  const command = parseCashPocketCommand(context.combinedText);
  if (!command) return;
  if (command.kind === 'list') {
    const pockets = await cashPocketService.list(context.company.id);
    await savePocketContext(context.company.id, context.message.phone, pockets);
    return;
  }
  if ('name' in command) {
    const pocket = await cashPocketService.findByName(context.company.id, command.name);
    if (pocket) await savePocketContext(context.company.id, context.message.phone, [pocket]);
  }
}

export async function handleCashOrganizationContext(context: VerticalContext): Promise<VerticalResult | null> {
  const input = context.combinedText;

  if (isCashFinancialSnapshot(input)) return text(financialSnapshotMessage(input));

  if (isFutureDataStatement(input)) {
    return text('Perfeito. Pode me mandar os valores, quem está devendo e o que está em caixa. Vou separar saldo, retiradas e valores a receber sem registrar número solto como despesa.');
  }

  const naturalNames = parseNaturalPocketNames(input);
  const assignment = parsePocketAssignment(input);
  if (naturalNames.length >= 1 && /\b(?:vai\s+se\s+chamar|se\s+chama)\b/i.test(input)) {
    const created: string[] = [];
    const existing: string[] = [];
    for (const name of naturalNames) {
      const result = await cashPocketService.create(context.company.id, name);
      (result.created ? created : existing).push(result.pocket.name);
    }
    const pockets = (await Promise.all(naturalNames.map(name => cashPocketService.findByName(context.company.id, name))))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (pockets.length) await savePocketContext(context.company.id, context.message.phone, pockets);

    if (assignment) {
      const assigned = await applyAssignment(context, assignment);
      const assignedText = assigned.actions.find(action => action.type === 'text');
      return text([
        created.length ? `🐷 Criados: ${created.join(', ')}.` : '',
        existing.length ? `↩️ Já existiam: ${existing.join(', ')}.` : '',
        assignedText?.type === 'text' ? assignedText.text : ''
      ].filter(Boolean).join('\n'));
    }

    return text([
      created.length ? `🐷 Criados: ${created.join(', ')}.` : '',
      existing.length ? `↩️ Já existiam: ${existing.join(', ')}.` : ''
    ].filter(Boolean).join('\n'));
  }

  if (assignment) return await applyAssignment(context, assignment);

  const explicitDelete = explicitPocketDeleteName(input);
  if (explicitDelete) {
    const pocket = await cashPocketService.findByName(context.company.id, explicitDelete);
    if (!pocket) return text(`Não encontrei o cofrinho *${explicitDelete}*.`);
    const result = await removePocket(context.company.id, pocket.id, pocket.name);
    await redis.del(pocketContextKey(context.company.id, context.message.phone));
    return result;
  }

  if (isPocketPronounDelete(input)) {
    const recent = await getPocketContext(context.company.id, context.message.phone);
    if (!recent?.ids.length) return null;
    if (recent.ids.length > 1) {
      return text(`Você acabou de ver ${recent.ids.length} cofrinhos. Para eu não apagar o errado, diga “apaga cofrinho NOME”.`);
    }
    const result = await removePocket(context.company.id, recent.ids[0]!, recent.names[0]!);
    await redis.del(pocketContextKey(context.company.id, context.message.phone));
    return result;
  }

  if (isSeparationIntent(input)) {
    return text([
      'Entendi 👍 Você quer administrar essa operação sem misturar com seus gastos pessoais.',
      'O melhor é usar um cofrinho separado para ela.',
      'Por exemplo: “criar cofrinho Vendas de roupas”.',
      'Depois você pode dizer “recebi 500 no cofrinho Vendas de roupas” ou mover registros já existentes para ele.'
    ].join('\n'));
  }

  return null;
}
