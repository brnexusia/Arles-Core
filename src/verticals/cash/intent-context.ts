import type { CashFinancialIntent } from './financial-intent.js';

const TTL_SECONDS = 30 * 60;

export interface CashFinancialIntentContext {
  version: 1;
  kind: CashFinancialIntent['kind'];
  operation: CashFinancialIntent['operation'];
  flow: CashFinancialIntent['flow'];
  scope: CashFinancialIntent['scope'];
  periodCanonical: string | null;
  reference: CashFinancialIntent['reference'];
  canonical: string;
  rememberedAt: string;
}

async function redisClient() {
  return (await import('../../infrastructure/redis.js')).redis;
}

function phoneKey(phone: string): string {
  return String(phone ?? '').replace(/\D/g, '');
}

function key(companyId: string, phone: string): string {
  return `arles:cash:intent-context:${companyId}:${phoneKey(phone)}`;
}

function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[!?.,;:]+$/g, '')
    .replace(/\s+/g, ' ');
}

export async function rememberCashFinancialIntentContext(
  companyId: string,
  phone: string,
  intent: CashFinancialIntent
): Promise<void> {
  // Lançamento ainda aguardando "sim" e aviso de dados futuros não viram contexto.
  // Já uma consulta aguardando período DEVE ser lembrada: assim uma resposta curta
  // como "este mês" completa exatamente a intenção que acabou de ser perguntada.
  if (intent.kind === 'transaction' || intent.kind === 'future_data') return;

  const snapshot: CashFinancialIntentContext = {
    version: 1,
    kind: intent.kind,
    operation: intent.operation,
    flow: intent.flow,
    scope: intent.scope,
    periodCanonical: intent.periodCanonical,
    reference: intent.reference,
    canonical: intent.canonical.slice(0, 1000),
    rememberedAt: new Date().toISOString()
  };

  const redis = await redisClient();
  await redis.set(key(companyId, phone), JSON.stringify(snapshot), 'EX', TTL_SECONDS);
}

export async function getCashFinancialIntentContext(
  companyId: string,
  phone: string
): Promise<CashFinancialIntentContext | null> {
  const redis = await redisClient();
  const raw = await redis.get(key(companyId, phone));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CashFinancialIntentContext>;
    if (parsed.version !== 1 || !parsed.kind || !parsed.canonical) return null;
    return parsed as CashFinancialIntentContext;
  } catch {
    return null;
  }
}

function allTimeCanonical(flow: CashFinancialIntent['flow']): string {
  if (flow === 'income') return 'total geral de todas as receitas';
  if (flow === 'expense') return 'total geral de todas as despesas';
  return 'total geral de todas as entradas e saídas';
}

function periodCanonical(flow: CashFinancialIntent['flow'], period: string): string {
  if (flow === 'income') return `quanto recebi ${period}?`;
  if (flow === 'expense') return `quanto gastei ${period}?`;
  return `quanto entrou e quanto saiu ${period}?`;
}

function followupPeriod(value: string): string | null {
  const clean = normalize(value).replace(/^e\s+/, '').trim();
  if (/^(hoje|ontem|anteontem)$/.test(clean)) return clean;
  if (/^(esta|essa) semana$|^semana passada$/.test(clean)) return clean === 'essa semana' ? 'esta semana' : clean;
  if (/^(este|esse) mes$|^mes passado$/.test(clean)) return clean === 'esse mes' ? 'este mês' : clean.replace('mes', 'mês');
  if (/^(este|esse) ano$|^ano passado$/.test(clean)) return clean === 'esse ano' ? 'este ano' : clean;
  const lastDays = clean.match(/^ultimos\s+(\d{1,3})\s+dias?$/);
  if (lastDays?.[1]) return `últimos ${lastDays[1]} dias`;
  return null;
}

/**
 * Expande apenas continuações curtas e inequívocas. Nada aqui inventa valor, período
 * ou entidade: a informação vem do contexto tipado anterior + do novo modificador.
 */
export function expandCashFinancialIntentFollowup(
  previous: CashFinancialIntentContext,
  current: string
): string | null {
  const value = normalize(current);
  if (!value || value.split(/\s+/).length > 6) return null;
  if (!['aggregate', 'query'].includes(previous.kind)) return null;

  const period = followupPeriod(value);
  if (period) return periodCanonical(previous.flow, period);

  const clean = value.replace(/^e\s+/, '').trim();
  if (/^(?:no total|ao todo|geral|desde o inicio|desde sempre|tudo|tudo isso)$/.test(clean)) {
    return allTimeCanonical(previous.flow);
  }

  if (/^(?:so|somente|apenas)?\s*(?:entradas?|receitas?|ganhos?|recebimentos?)$/.test(clean)) {
    if (previous.scope === 'all_time') return allTimeCanonical('income');
    if (previous.periodCanonical) return periodCanonical('income', previous.periodCanonical);
    return null;
  }

  if (/^(?:so|somente|apenas)?\s*(?:saidas?|despesas?|gastos?|compras?)$/.test(clean)) {
    if (previous.scope === 'all_time') return allTimeCanonical('expense');
    if (previous.periodCanonical) return periodCanonical('expense', previous.periodCanonical);
    return null;
  }

  return null;
}
