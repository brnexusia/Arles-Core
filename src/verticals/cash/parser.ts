import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { CashTransactionInput, CashTransactionType } from './types.js';
import { brazilParts, dateIsoOffset, isoBrazil } from './time.js';
import { isCashProtectedNonTransaction } from './ledger.js';

const CATEGORIES = [
  'Alimentação',
  'Transporte',
  'Saúde',
  'Moradia',
  'Educação',
  'Pessoal',
  'Reserva',
  'Receita',
  'Outros'
] as const;

const ParsedTransactionSchema = z.object({
  is_transaction: z.boolean(),
  type: z.enum(['income', 'expense']),
  amount: z.number().positive().nullable(),
  category: z.enum(CATEGORIES),
  merchant: z.string(),
  description: z.string(),
  transaction_date: z.string()
});

const EXPENSE = /\b(gastei|gasto|paguei|comprei|despesa|saiu|debitei|custou|pague|guardei|reservei|separei|retirei|retirou|retiraram|saquei|sacou)\b/i;
const INCOME = /\b(recebi|recebimento|ganhei|entrou|vendi|receita|renda|faturei|depositaram|pix recebido|sal[aá]rio|freela|freelance)\b/i;
const MOVEMENT = /\b(gastei|gasto|paguei|comprei|guardei|reservei|separei|retirei|retirou|retiraram|saquei|sacou|recebi|ganhei|entrou|vendi|faturei|depositaram)\b/gi;

const WEEKDAY_INDEX: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  'segunda-feira': 1,
  terca: 2,
  'terca-feira': 2,
  quarta: 3,
  'quarta-feira': 3,
  quinta: 4,
  'quinta-feira': 4,
  sexta: 5,
  'sexta-feira': 5,
  sabado: 6
};

function amountMatches(text: string): RegExpMatchArray[] {
  return [...text.matchAll(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/gi)];
}

function amountFrom(text: string): number | null {
  const matches = amountMatches(text);
  for (const match of matches) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 8), match.index ?? 0);
    const after = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 5);
    if (/\bdia\s*$/i.test(before) || /[\/-]\s*$/.test(before) || /^\s*[\/-]\s*\d/.test(after)) continue;
    const raw = match[1]!;
    const normalized = /^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(raw)
      ? raw.replace(/\./g, '').replace(',', '.')
      : raw.replace(',', '.');
    const value = Number(normalized);
    if (Number.isFinite(value) && value > 0) return Math.round(value * 100) / 100;
  }
  return null;
}

function transactionType(text: string, amount: number | null): CashTransactionType | null {
  if (INCOME.test(text)) return 'income';
  if (EXPENSE.test(text)) return 'expense';
  if (!amount) return null;

  const usefulText = text.replace(/[\d.,R$\s]/gi, '');
  return usefulText.length >= 2 ? 'expense' : null;
}

function weekdayDateFrom(text: string): string | null {
  const value = String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const match = value.match(/\b(domingo|segunda(?:-feira)?|terca(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|sabado)\b/);
  if (!match?.[1]) return null;
  const target = WEEKDAY_INDEX[match[1]];
  if (target == null) return null;
  const today = brazilParts();
  const delta = (today.weekday - target + 7) % 7;
  return dateIsoOffset(-delta);
}

function dateFrom(text: string): string {
  if (/\bontem\b/i.test(text)) return dateIsoOffset(-1);
  if (/\banteontem\b/i.test(text)) return dateIsoOffset(-2);
  if (/\bhoje\b/i.test(text)) return isoBrazil();

  const explicit = text.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (explicit) {
    const now = brazilParts();
    const yearRaw = explicit[3];
    const year = yearRaw ? Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw) : now.year;
    const month = Number(explicit[2]);
    const day = Number(explicit[1]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      !Number.isNaN(date.getTime()) &&
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return weekdayDateFrom(text) ?? isoBrazil();
}

export function categoryFrom(text: string, type: CashTransactionType): string {
  if (type === 'income') return 'Receita';
  const value = text.toLowerCase();

  if (/\b(guardei|reservei|separei|poupança|poupanca|reserva)\b/.test(value)) return 'Reserva';
  if (/mercado|supermercado|feira|açougue|acougue|padaria|pizzaria|pizza|almoço|almoco|jantar|lanche|acaraj[eé]|ifood|delivery/.test(value)) return 'Alimentação';
  if (/uber|\b99\b|gasolina|combustível|combustivel|estacionamento|ônibus|onibus|metrô|metro|passagem|bicicleta/.test(value)) return 'Transporte';
  if (/farmácia|farmacia|médico|medico|consulta|exame|plano de saúde|plano de saude|remédio|remedio|xarope/.test(value)) return 'Saúde';
  if (/\bluz\b|\bágua\b|\bagua\b|internet|aluguel|condomínio|condominio|\bgás\b|\bgas\b/.test(value)) return 'Moradia';
  if (/escola|curso|livro|faculdade|mensalidade/.test(value)) return 'Educação';
  if (/salão|salao|unha|manicure|academia|roupa|blusa|blusinha|camisa|camiseta|calça|calca|vestido|short|bermuda|sapato|t[eê]nis|shopping|shein|acess[oó]rio|presente/.test(value)) return 'Pessoal';
  return 'Outros';
}

function merchantFrom(text: string): string {
  const withoutDate = text
    .replace(/\b(hoje|ontem|anteontem|agora)\b/gi, '')
    .replace(/\b(domingo|segunda(?:-feira)?|terça(?:-feira)?|terca(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|sábado|sabado)\b/gi, '')
    .replace(/\s+(?:no|na|do|da|de)\s+cofrinho\s+[^,.!?;]+/gi, ' ');
  const match = withoutDate.match(/\b(?:no|na|em|para o|para a|de)\s+([^,.]+?)(?:\s+(?:por|de)\s+r?\$?\s*\d|\s+r?\$?\s*\d|$)/i);
  return (match?.[1] ?? '').trim().slice(0, 120);
}

export function descriptionFrom(text: string): string {
  let value = text.trim();
  value = value
    .replace(/\b(hoje|ontem|anteontem|agora)\b/gi, ' ')
    .replace(/\b(domingo|segunda(?:-feira)?|terça(?:-feira)?|terca(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|sábado|sabado)\b/gi, ' ')
    .replace(/\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/g, ' ')
    .replace(/^\s*eu\s+/i, '')
    .replace(/^\s*(?:gastei|gasto|paguei|pague|comprei|despesa|saiu|debitei|custou|guardei|reservei|separei|retirei|retirou|retiraram|saquei|sacou|recebi|recebimento|ganhei|entrou|vendi|receita|renda|faturei|depositaram)\s+/i, '')
    .replace(/(?:\b(?:por|de)\s+)?(?:r\$\s*)?\d{1,3}(?:\.\d{3})*(?:[.,]\d{1,2})?(?:\s*reais?)?/gi, ' ')
    .replace(/\s+(?:no|na|do|da|de)\s+cofrinho\s+[^,.!?;]+$/i, ' ')
    .replace(/^\s*(?:um|uma)\s+/i, '')
    .replace(/^\s*(?:no|na|em|de)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b(?:por|de|em)\s*$/i, '')
    .trim();

  if (!value && /\bcofrinho\b/i.test(text)) return '';
  return (value || text.trim()).slice(0, 500);
}

function hasItemEnumeration(text: string): boolean {
  const clean = String(text ?? '').trim();
  return /[,;]/.test(clean) || /\b\w+\s+e\s+\w+\b/i.test(clean);
}

function specificDescription(text: string, aiDescription: string, deterministic: CashTransactionInput | null): string {
  const ai = aiDescription.trim();
  const source = descriptionFrom(text).trim();
  const generic = /\b(itens? diversos?|compras? diversas?|coisas? diversas?|varios itens|vários itens)\b/i.test(ai);
  if (source && (generic || hasItemEnumeration(text))) return source.slice(0, 500);
  return (source || ai || deterministic?.description || '').slice(0, 500);
}

export function deterministicCashParse(text: string): CashTransactionInput | null {
  // Perguntas, saldo e cenários hipotéticos nunca são lançamentos. Essa barreira fica
  // dentro do parser para continuar segura mesmo se uma nova rota futura chamar aqui.
  if (isCashProtectedNonTransaction(text)) return null;

  const amount = amountFrom(text);
  const type = transactionType(text, amount);
  if (!type || !amount) return null;
  return {
    type,
    amount,
    category: categoryFrom(text, type),
    merchant: merchantFrom(text),
    description: descriptionFrom(text),
    transactionDate: dateFrom(text)
  };
}

export function isStrongDeterministicCashTransaction(
  text: string,
  parsed: CashTransactionInput | null = deterministicCashParse(text)
): boolean {
  if (!parsed || isCashProtectedNonTransaction(text)) return false;
  const clean = text.trim();
  if (!clean || clean.length > 140 || /\n/.test(clean)) return false;

  if (amountMatches(clean).length !== 1) return false;
  const movements = clean.match(MOVEMENT) ?? [];
  if (movements.length > 1) return false;

  const explicitMovement = EXPENSE.test(clean) || INCOME.test(clean);
  const compactKnownCategory = clean.split(/\s+/).length <= 8 && parsed.category !== 'Outros';
  return explicitMovement && parsed.category !== 'Outros' || compactKnownCategory;
}

export class CashParser {
  private readonly client = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;

  async parse(text: string): Promise<CashTransactionInput | null> {
    // Também bloqueia ANTES da chamada ao GPT. Simulação e consulta custam zero IA
    // e nunca chegam a gerar resumo de confirmação financeira.
    if (isCashProtectedNonTransaction(text)) return null;

    const deterministic = deterministicCashParse(text);
    if (isStrongDeterministicCashTransaction(text, deterministic)) return deterministic;
    if (!this.client) return deterministic;

    try {
      const response = await this.client.responses.parse({
        model: env.openaiModel,
        input: [
          {
            role: 'system',
            content: [
              'Você interpreta APENAS lançamentos novos do Arles Cash em português brasileiro quando a frase saiu do padrão simples coberto por regras.',
              'Entenda linguagem natural, erros de digitação, abreviações, gírias e frases curtas.',
              'Perguntas, hipóteses, simulações, cálculos de saldo e frases com “se eu gastar/receber” NÃO são lançamentos: is_transaction=false.',
              'Nunca invente valor, data, loja, pessoa ou descrição que não estejam sustentados pela mensagem.',
              'expense é dinheiro que realmente saiu do disponível; income é dinheiro que realmente entrou.',
              '“guardei”, “reservei” ou “separei dinheiro” é expense na categoria Reserva.',
              '“retirei”, “retirou”, “sacou” ou equivalente é saída real quando houver valor.',
              'Frases como “120 no almoço” ou “farmácia 45” são despesas somente quando estão sendo informadas como fato, não pergunta/simulação.',
              'Se não houver lançamento REAL e valor identificáveis, is_transaction=false.',
              'Use SOMENTE: Alimentação, Transporte, Saúde, Moradia, Educação, Pessoal, Reserva, Receita, Outros.',
              'Toda entrada usa Receita. Dinheiro guardado usa Reserva.',
              'merchant é loja, pessoa ou local somente quando estiver claro.',
              'description deve ser curta e humana, sem repetir verbo, valor, data nem o nome do cofrinho.',
              'Quando o usuário citar vários itens dentro do mesmo gasto, preserve os nomes dos itens na description.',
              'Nunca troque uma lista explícita por “itens diversos”, “compras diversas”, “coisas diversas” ou equivalente.',
              `Hoje no fuso UTC-3 é ${isoBrazil()}. Converta datas relativas e dias da semana para YYYY-MM-DD.`
            ].join('\n')
          },
          { role: 'user', content: text }
        ],
        text: { format: zodTextFormat(ParsedTransactionSchema, 'cash_transaction') }
      });
      const parsed = response.output_parsed;
      if (!parsed?.is_transaction || !parsed.amount) return deterministic;

      return {
        type: parsed.type,
        amount: Math.round(parsed.amount * 100) / 100,
        category: parsed.type === 'income' ? 'Receita' : parsed.category,
        merchant: parsed.merchant.trim().slice(0, 120),
        description: specificDescription(text, parsed.description, deterministic),
        transactionDate: weekdayDateFrom(text)
          ?? (/^\d{4}-\d{2}-\d{2}$/.test(parsed.transaction_date)
            ? parsed.transaction_date
            : deterministic?.transactionDate ?? isoBrazil())
      };
    } catch (error) {
      console.error('[CashParser] falha na IA; usando fallback determinístico:', error);
      return deterministic;
    }
  }
}

export const cashParser = new CashParser();