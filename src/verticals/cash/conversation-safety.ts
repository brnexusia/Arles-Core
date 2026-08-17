import type { VerticalContext, VerticalResult } from '../vertical.js';
import {
  clearCashRecentRecordReference,
  consumeCashRecentRecordReference,
  getCashQueryContext,
  rememberCashDeferredQuery,
  rememberCashQueryContext
} from './conversation-state.js';
import { deterministicCashParse } from './parser.js';
import { deterministicCashQuery } from './query.js';

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

function financialish(value: string): boolean {
  const t = normalize(value);
  return /\b(gast|gstei|gsti|gastano|pag|pguei|pagano|compr|receb|rcebi|recebeno|ganh|entr|sai|saldo|despes|receit|registro|lancamento|moviment|cofrinh|caixinh|quanto|qnt|qto|qnto|soma|some|total|historico|relatorio|previs|simul)\w*/.test(t);
}

export function normalizeCashNoisyLanguage(input: string): string {
  const original = String(input ?? '').trim();
  if (!original || !financialish(original)) return original;
  let value = original;
  const replacements: Array<[RegExp, string]> = [
    [/\b(?:qnt|qto|qnto|qntt)\b/gi, 'quanto'], [/\bhj\b/gi, 'hoje'], [/\bagr\b/gi, 'agora'],
    [/\b(?:mto|mt)\b/gi, 'muito'], [/\b(?:gstei|gsti|gasteii)\b/gi, 'gastei'], [/\b(?:gastano|gastandoo)\b/gi, 'gastando'],
    [/\b(?:pguei|pagueii)\b/gi, 'paguei'], [/\b(?:pagano|pagandoo)\b/gi, 'pagando'], [/\b(?:rcebi|recebii)\b/gi, 'recebi'],
    [/\b(?:recebeno|recebendoo)\b/gi, 'recebendo'], [/\b(?:entrano|entrandoo)\b/gi, 'entrando'], [/\b(?:saino|saindoo)\b/gi, 'saindo']
  ];
  for (const [pattern, replacement] of replacements) value = value.replace(pattern, replacement);
  value = value.replace(/\bq\b/gi, 'que');
  return value.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

export interface CashMultiIntent { primary: string; secondary: string }

function queryLike(value: string): boolean {
  return /\b(quanto|saldo|qual|quais|mostra|lista|historico|registros?|lancamentos?|gastei|recebi|entrou|saiu|sobrou|resta|tenho)\b/.test(normalize(value));
}

export function parseCashMultiIntent(input: string): CashMultiIntent | null {
  const clean = String(input ?? '').trim();
  if (!clean) return null;
  const explicit = clean.match(/^(.+?)\s*(?:;|,|\se\s)\s*(?:(?:depois\s+)?(?:me\s+)?(?:diz|fala|mostra|informa|calcula)|(?:quero\s+saber))\s+(.+)$/i);
  if (explicit?.[1] && explicit[2] && queryLike(explicit[2])) return { primary: explicit[1].trim(), secondary: explicit[2].trim() };
  const direct = clean.match(/^(.+?)\s+e\s+((?:quanto|qual|quais|saldo|meu saldo)\b.+)$/i);
  if (direct?.[1] && direct[2] && queryLike(direct[2])) return { primary: direct[1].trim(), secondary: direct[2].trim() };
  return null;
}

export function canonicalCashDeferredQuery(input: string): string | null {
  const value = normalize(input).replace(/[?!.]+$/g, '').trim();
  if (/\bsaldo\b/.test(value) || /\bquanto\b.*\b(?:tenho|sobrou|sobra|resta|restou|ficou|disponivel)\b/.test(value)) return 'saldo';
  const candidate = String(input ?? '').trim();
  return candidate && deterministicCashQuery(candidate) ? candidate : null;
}

function stripKnownPeriod(input: string): string {
  return input
    .replace(/\b(hoje|ontem|anteontem)\b/gi, ' ')
    .replace(/\b(esta|essa|ultima|última|passada|atual)\s+semana\b|\bsemana\s+(passada|atual)\b/gi, ' ')
    .replace(/\b(este|esse|ultimo|último|passado|atual)\s+m[eê]s\b|\bm[eê]s\s+(passado|atual)\b/gi, ' ')
    .replace(/\b(este|esse|ultimo|último|passado|atual)\s+ano\b|\bano\s+(passado|atual)\b/gi, ' ')
    .replace(/\b(?:em\s+)?(?:janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:\s+de\s+20\d{2})?\b/gi, ' ')
    .replace(/[?!.]+$/g, '').replace(/\s+/g, ' ').trim();
}

function stripLeadingFollowup(input: string): string {
  return String(input ?? '').trim().replace(/^e\s+/i, '').replace(/[?!.]+$/g, '').trim();
}

function isTemporalFollowup(value: string): boolean {
  const t = normalize(value).replace(/^e\s+/, '').replace(/[?!.]+$/g, '').trim();
  return /^(?:hoje|ontem|anteontem|(?:esta|essa|ultima|passada|atual) semana|semana (?:passada|atual)|(?:este|esse|ultimo|passado|atual) mes|mes (?:passado|atual)|(?:este|esse|ultimo|passado|atual) ano|ano (?:passado|atual)|(?:em )?(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?: de 20\d{2})?)$/.test(t);
}

function switchQueryType(previous: string, current: string): string | null {
  const next = normalize(current).replace(/^e\s+/, '').replace(/[?!.]+$/g, '').trim();
  if (/^(?:so )?(?:entradas?|receitas?|recebimentos?|ganhos?)$/.test(next)) {
    const changed = previous.replace(/\bquanto\s+(?:eu\s+)?(?:gastei|paguei|comprei)\b/i, 'quanto recebi').replace(/\b(?:gastos?|despesas?|compras?|saidas?)\b/i, 'receitas');
    return changed !== previous ? changed : `quanto recebi ${previous}`;
  }
  if (/^(?:so )?(?:saidas?|despesas?|gastos?|compras?)$/.test(next)) {
    const changed = previous.replace(/\bquanto\s+(?:eu\s+)?(?:recebi|ganhei)\b/i, 'quanto gastei').replace(/\b(?:receitas?|entradas?|recebimentos?|ganhos?)\b/i, 'despesas');
    return changed !== previous ? changed : `quanto gastei ${previous}`;
  }
  return null;
}

export function expandCashQueryContext(previous: string, current: string): string | null {
  const prior = String(previous ?? '').trim(), now = String(current ?? '').trim();
  if (!prior || !now || now.split(/\s+/).length > 10) return null;
  const switched = switchQueryType(prior, now);
  if (switched && deterministicCashQuery(switched)) return switched;
  if (isTemporalFollowup(now)) {
    const candidate = `${stripKnownPeriod(prior)} ${stripLeadingFollowup(now)}`.replace(/\s+/g, ' ').trim();
    return deterministicCashQuery(candidate) ? candidate : null;
  }
  const clean = normalize(now).replace(/^e\s+/, '').replace(/[?!.]+$/g, '').trim();
  const filter = /^(?:so\s+)?(?:com|de|do|da|no|na|em)\s+.+/.test(clean)
    || /^(?:so\s+)?(?:alimentacao|transporte|saude|moradia|educacao|pessoal|receita|outros)$/.test(clean)
    || /^(?:so\s+)?(?:acima de|mais de|maior que|abaixo de|menos de|menor que|ate)\s+(?:r\$\s*)?\d/.test(clean);
  if (filter) {
    const candidate = `${prior.replace(/[?!.]+$/g, '')} ${stripLeadingFollowup(now)}`.replace(/\s+/g, ' ').trim();
    return deterministicCashQuery(candidate) ? candidate : null;
  }
  if (/^(?:o\s+)?(?:maior|mais caro|mais cara)$/.test(clean)) {
    const candidate = `${prior.replace(/[?!.]+$/g, '')} maior gasto`.replace(/\s+/g, ' ').trim();
    return deterministicCashQuery(candidate) ? candidate : null;
  }
  return null;
}

export function isCashVagueDestructiveReference(input: string): boolean {
  const value = normalize(input).replace(/[?!.]+$/g, '').trim();
  return /^(?:apaga|apague|remove|remova|exclui|exclua|cancela|cancele|deleta|delete|tira|retira|edita|edite|corrige|corrija|altera|altere|muda|mude)\s+(?:ele|ela|esse|essa|isso|este|esta)(?:\s+(?:ai|por favor|pfv|na verdade))?$/.test(value);
}

export function isCashAmbiguousCalculationRemoval(input: string): boolean {
  const value = normalize(input).replace(/[?!.]+$/g, '').trim();
  return /\b(?:tira|remove|retira|exclui|desconsidera)\b.+\b(?:dai|desse total|dessa conta|desse calculo|dessa soma|do total|da soma)\b/.test(value)
    && !/\b(?:registro|lancamento|item)\s*(?:#|n|numero)?\s*\d+\b/.test(value);
}

function acknowledgement(input: string): boolean {
  const value = normalize(input).replace(/[?!.]+$/g, '').trim();
  return /^(certo|ok|okay|blz|beleza|entendi|show|perfeito|ta bom|tranquilo|valeu|obrigado|obrigada|massa|top)$/.test(value);
}

function appendSafetyNote(result: VerticalResult, note: string): VerticalResult {
  return { ...result, actions: [...result.actions, { type: 'text', text: note }] };
}
function stagedRegistration(result: VerticalResult): boolean {
  return result.actions.some(action => action.type === 'text' && action.text.startsWith('🧾 Antes de registrar'));
}

export async function handleCashConversationSafety(context: VerticalContext): Promise<VerticalResult | null> {
  const normalizedInput = normalizeCashNoisyLanguage(context.combinedText);
  if (normalizedInput) context.combinedText = normalizedInput;
  const companyId = context.company.id, phone = context.message.phone;
  const quoted = Boolean(context.message.quotedMessageId || context.message.quotedText);

  const multi = parseCashMultiIntent(context.combinedText);
  if (multi) {
    const parsed = deterministicCashParse(multi.primary);
    const deferred = canonicalCashDeferredQuery(multi.secondary);
    if (parsed && deferred) {
      const { cashService } = await import('./service.js');
      const access = await cashService.accessState(companyId);
      if (access.hasAccess) {
        const { stageCashRegistration } = await import('./confirmation.js');
        const staged = await stageCashRegistration({ ...context, combinedText: multi.primary }, [parsed], multi.primary);
        if (stagedRegistration(staged)) {
          await rememberCashDeferredQuery(companyId, phone, deferred);
          return appendSafetyNote(staged, deferred === 'saldo'
            ? 'Também entendi que você quer ver o saldo. Assim que confirmar este lançamento, eu mostro o saldo atualizado na sequência.'
            : 'Também entendi a sua consulta. Assim que confirmar este lançamento, eu respondo a consulta na sequência.');
        }
        return staged;
      }
    }
  }

  const previousQuery = await getCashQueryContext(companyId, phone);
  if (previousQuery) {
    const expanded = expandCashQueryContext(previousQuery, context.combinedText);
    if (expanded) context.combinedText = expanded;
  }
  if (deterministicCashQuery(context.combinedText)) await rememberCashQueryContext(companyId, phone, context.combinedText);

  if (!quoted && isCashAmbiguousCalculationRemoval(context.combinedText)) {
    await clearCashRecentRecordReference(companyId, phone);
    return text('Quero ter certeza antes de mexer nos seus dados.\nVocê quer apenas *desconsiderar isso do cálculo* ou quer *apagar um lançamento de verdade*?\nSe for apagar, diga qual registro (ex.: “apaga o 2”).');
  }
  if (!quoted && isCashVagueDestructiveReference(context.combinedText)) {
    const hasRecentReference = await consumeCashRecentRecordReference(companyId, phone);
    if (!hasRecentReference) return text('Quero evitar apagar ou alterar o registro errado.\nMe diga qual lançamento você quer mexer. Você pode mandar “histórico” e depois “apaga o 2” ou “edita o 2”.');
    return null;
  }
  if (!acknowledgement(context.combinedText)) await clearCashRecentRecordReference(companyId, phone);
  return null;
}
