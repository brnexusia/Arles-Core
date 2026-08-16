import { redis } from '../../infrastructure/redis.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';

type CompactSubject = 'expense' | 'income' | 'all';

function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function queryKey(companyId: string, phone: string): string {
  return `arles:cash:query:${companyId}:${phone.replace(/\D/g, '')}`;
}

function subjectFromQuery(input: string): CompactSubject {
  const value = normalize(input);
  if (/\b(receita|receitas|recebi|recebimentos?|entrada|entradas|ganhei|salario)\b/.test(value)) return 'income';
  if (/\b(gasto|gastos|gastei|despesa|despesas|comprei|compras|paguei|pagamentos?|saidas?)\b/.test(value)) return 'expense';
  return 'all';
}

function capitalize(value: string): string {
  const clean = value.trim();
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : clean;
}

export function cleanCashListItemLabel(input: string): string {
  const original = String(input ?? '').trim();
  if (!original) return 'Lançamento';

  const normalized = normalize(original);
  if (/\b(guardei|reservei|separei|poupei)\b/.test(normalized)) return 'Reserva';

  let value = original
    .replace(/\s+(?:e\s+)?(?:me\s+)?(?:sobrou|restou|sobraram|restaram)\b.*$/i, '')
    .replace(/,?\s*(?:e\s+)?comprei\s+tamb[eé]m\s+(?:um|uma|uns|umas)?\s*/gi, ', ')
    .replace(/^\s*(?:e\s+)?(?:com\s+os\s+outros(?:\s+\d+(?:[.,]\d{1,2})?)?\s+)?(?:eu\s+)?/i, '')
    .replace(/^\s*(?:paguei|pague|gastei|gastei com|comprei|comprei uma|comprei um|recebi|ganhei|entrou)\s+/i, '')
    .replace(/^\s*(?:um|uma|uns|umas)\s+/i, '')
    .replace(/^\s*(?:itens?\s*,?\s*objetos?\s*,?\s*)+/i, '')
    .replace(/\b(?:uns?\s+)?itens?\s*,\s*objetos?\s*,?\s*/gi, '')
    .replace(/\s*,\s*,+/g, ', ')
    .replace(/^\s*[,;:\-]+\s*|\s*[,;:\-]+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!value) value = original;
  if (value.length > 90) value = value.slice(0, 87).trimEnd() + '…';
  return capitalize(value);
}

function periodPhrase(label: string): string {
  const value = normalize(label);
  if (value === 'hoje') return 'de hoje';
  if (value === 'ontem') return 'de ontem';
  if (value === 'anteontem') return 'de anteontem';
  if (value === 'esta semana' || value === 'essa semana') return 'desta semana';
  if (value === 'semana passada') return 'da semana passada';
  if (value === 'este mes' || value === 'esse mes') return 'deste mês';
  if (value === 'mes passado') return 'do mês passado';
  if (value === 'este ano' || value === 'esse ano') return 'deste ano';
  if (value === 'ano passado') return 'do ano passado';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(label.trim())) return `de ${label.trim()}`;
  if (value.startsWith('de ')) return label.trim().toLowerCase();
  return `de ${label.trim().toLowerCase()}`;
}

function title(subject: CompactSubject, periodLabel: string): string {
  const period = periodPhrase(periodLabel);
  if (subject === 'income') return `Suas receitas ${period} foram:`;
  if (subject === 'expense') return `Seus gastos ${period} foram:`;
  return `Seus lançamentos ${period} foram:`;
}

type ParsedCompactLine = {
  label: string;
  amount: string;
};

function parseCompactLine(line: string): ParsedCompactLine | null {
  const match = line.trim().match(/^•\s+(.+?)\s+—\s+(R\$\s*[\d.]+(?:,\d{1,2})?)\s+·\s+\d{2}\/\d{2}\/\d{4}$/);
  if (!match?.[1] || !match[2]) return null;
  return {
    label: cleanCashListItemLabel(match[1]),
    amount: match[2].replace(/\s+/g, ' ')
  };
}

export function formatCashCompactListText(raw: string, queryText: string): string | null {
  const lines = String(raw ?? '').split('\n').map(line => line.trimEnd());
  const first = lines[0]?.trim() ?? '';
  const header = first.match(/^📋\s+(.+):$/);
  if (!header?.[1]) return null;

  const items = lines
    .slice(1)
    .map(parseCompactLine)
    .filter((item): item is ParsedCompactLine => Boolean(item));
  if (!items.length) return null;

  const subject = subjectFromQuery(queryText);
  const body = items.map(item => `${item.label} — ${item.amount}`);
  const truncated = lines.find(line => /^Mostrando\s+\d+\s+de\s+\d+\s+registros/i.test(line.trim()));

  return [
    title(subject, header[1]),
    '',
    ...body,
    truncated ? `\n${truncated.trim()}` : ''
  ].filter(Boolean).join('\n');
}

function chunkText(value: string): VerticalResult['actions'] {
  const lines = value.split('\n');
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > 3000 && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.map(text => ({ type: 'text' as const, text }));
}

export async function formatCashUserResponse(
  context: VerticalContext,
  result: VerticalResult | null
): Promise<VerticalResult | null> {
  if (!result) return result;
  const textActions = result.actions.filter(action => action.type === 'text');
  if (!textActions.length) return result;

  const raw = textActions.map(action => action.type === 'text' ? action.text : '').join('\n');
  if (!raw.trimStart().startsWith('📋')) return result;

  const rememberedQuery = await redis.get(queryKey(context.company.id, context.message.phone));
  const formatted = formatCashCompactListText(raw, rememberedQuery || context.combinedText);
  if (!formatted) return result;

  const nonText = result.actions.filter(action => action.type !== 'text');
  return { actions: [...chunkText(formatted), ...nonText] };
}
