import type { CashTransactionType } from './types.js';
import { dateIsoOffset, isoBrazil } from './time.js';

export type CashRecordTarget =
  | { kind: 'last' }
  | { kind: 'index'; index: number };

export interface CashEditPatch {
  type?: CashTransactionType;
  amount?: number;
  category?: string;
  description?: string;
  transaction_date?: string;
}

const CATEGORY_CANONICAL: Record<string, string> = {
  alimentacao: 'Alimentação',
  transporte: 'Transporte',
  saude: 'Saúde',
  moradia: 'Moradia',
  educacao: 'Educação',
  pessoal: 'Pessoal',
  reserva: 'Reserva',
  receita: 'Receita',
  outros: 'Outros'
};

export function normalizeCashText(value: string): string {
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');

  if (/^(?:quais(?: sao)? os comandos|quais comandos|que comandos (?:tem|existem)|me mostra os comandos)[!.? ]*$/.test(normalized)) {
    return 'comandos';
  }
  return normalized;
}

export function asksHowToManage(text: string): boolean {
  const value = normalizeCashText(text);
  const asksHow = /\b(como|posso|consigo|da pra|da para|tem como|o que faco|o que fazer)\b/.test(value);
  const management = /\b(edit|alter|mud|corrig|ajust|apag|exclu|remov|retir|delet|observa|descricao|registro|registo)\w*/.test(value);
  return asksHow && management;
}

function explicitIndex(value: string, verbSource: string): number | null {
  const named = value.match(/\b(?:registro|registo|item|numero|n|#)\s*(\d{1,2})\b/);
  if (named) return Number(named[1]);
  const direct = value.match(new RegExp(`(?:${verbSource})\\w*\\s+(?:o\\s+)?(\\d{1,2})(?:\\s*[!.?])?$`, 'i'));
  return direct ? Number(direct[1]) : null;
}

export function deletionTarget(text: string): CashRecordTarget | null {
  const value = normalizeCashText(text);
  if (asksHowToManage(value)) return null;
  if (/^(errei|foi errado|registrei errado|registei errado)[!. ]*$/.test(value)) return { kind: 'last' };
  const verbSource = 'apag|exclu|remov|retir|tir|cancel|delet';
  if (!new RegExp(`(?:${verbSource})\\w*`, 'i').test(value)) return null;
  const index = explicitIndex(value, verbSource);
  if (index && index >= 1 && index <= 20) return { kind: 'index', index };
  if (/\b(ultimo|agora|recente|registro|registo|lancamento|gasto|despesa|receita|compra)\b/.test(value)) return { kind: 'last' };
  // Referências curtas são comuns logo depois de um lançamento/edição: “cancela ele”,
  // “apaga esse”, “remove isso”. Nesses casos, “ele/esse/isso” aponta para o registro
  // que acabou de ser tratado, portanto o alvo seguro é o lançamento mais recente.
  if (/\b(ele|ela|esse|essa|isso|este|esta)\b/.test(value)) return { kind: 'last' };
  return null;
}

export function editTarget(text: string): CashRecordTarget | null {
  const value = normalizeCashText(text);
  if (asksHowToManage(value)) return null;
  const verbSource = 'edit|alter|mud|corrig|ajust|troc';
  if (!new RegExp(`(?:${verbSource})\\w*`, 'i').test(value)) return null;
  const index = explicitIndex(value, verbSource);
  if (index && index >= 1 && index <= 20) return { kind: 'index', index };
  if (/\b(ultimo|agora|recente|registro|registo|lancamento|gasto|despesa|receita|compra)\b/.test(value)) return { kind: 'last' };
  return null;
}

function parseMoney(raw: string): number | null {
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null;
}

function parseExplicitDate(text: string): string | undefined {
  const value = normalizeCashText(text);
  if (/\banteontem\b/.test(value)) return dateIsoOffset(-2);
  if (/\bontem\b/.test(value)) return dateIsoOffset(-1);
  if (/\bhoje\b/.test(value)) return isoBrazil();
  const match = text.match(/\b(?:data\s*)?(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/i);
  if (!match) return undefined;
  const nowYear = Number(isoBrazil().slice(0, 4));
  const yearRaw = match[3];
  const year = yearRaw ? Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw) : nowYear;
  const month = Number(match[2]);
  const day = Number(match[1]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(check.getTime()) || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseCashEditPatch(text: string): CashEditPatch {
  const normalized = normalizeCashText(text);
  const patch: CashEditPatch = {};
  const moneyMatch = text.match(/\b(?:valor(?:\s+foi|\s+era|\s+para)?|pre[cç]o(?:\s+foi|\s+era|\s+para)?|foram|foi|era|custou|fica|para)\s*(?:de|em)?\s*(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\b/i)
    ?? text.match(/\b(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)\s*reais?\b/i);
  if (moneyMatch?.[1]) {
    const amount = parseMoney(moneyMatch[1]);
    if (amount) patch.amount = amount;
  }

  for (const [key, canonical] of Object.entries(CATEGORY_CANONICAL)) {
    if (new RegExp(`\\bcategoria\\b.*\\b${key}\\b`, 'i').test(normalized) || new RegExp(`\\bpara\\s+${key}\\b`, 'i').test(normalized)) {
      patch.category = canonical;
      break;
    }
  }

  const typeMatch = normalized.match(/\b(?:tipo\s+)?(receita|entrada|despesa|saida)\b/);
  if (typeMatch && /\b(tipo|transforma|muda|altera|troca)\b/.test(normalized)) {
    patch.type = /receita|entrada/.test(typeMatch[1]!) ? 'income' : 'expense';
    if (patch.type === 'income') patch.category = 'Receita';
  }

  const descriptionMatch = text.match(/\b(?:descri[cç][aã]o|obs(?:erva[cç][aã]o)?|observa[cç][aã]o)\s*(?:para|como|é|e|:|=|-)?\s*(.+)$/i);
  if (descriptionMatch?.[1]) patch.description = descriptionMatch[1].trim().replace(/[.!?]+$/, '').slice(0, 500);

  const date = parseExplicitDate(text);
  if (date && /\b(data|hoje|ontem|anteontem|dia)\b/.test(normalized)) patch.transaction_date = date;
  return patch;
}

export function hasCashEditPatch(patch: CashEditPatch): boolean {
  return Object.keys(patch).length > 0;
}

export function managementHelpMessage(): string {
  return [
    '✏️ Para editar ou remover registros:',
    '',
    '🗑️ Remover o mais recente → “retira o registro de agora”',
    '🗑️ Remover pelo histórico → “apaga o 2”',
    '✏️ Editar o mais recente → “edita o último”',
    '✏️ Editar direto → “muda o último para 18 reais”',
    '📝 Alterar observação → “descrição: blusinha na SHEIN”',
    '📅 Alterar data → “foi ontem”',
    '',
    'Se quiser ver os números dos registros, mande “histórico”.'
  ].join('\n');
}
