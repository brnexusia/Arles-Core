import { CASH_NATURAL_LANGUAGE_EXAMPLES, type CashNaturalLanguageExample } from './natural-language-corpus.js';
import { CASH_NATURAL_LANGUAGE_EXPANDED_EXAMPLES } from './natural-language-corpus-expanded.js';

function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[!?.,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Mantém uma base única antes de gerar a segunda camada. Assim a capacidade
// realmente dobra em frases diferentes, em vez de contar duplicatas do corpus.
const SOURCE_INDEX = new Map<string, CashNaturalLanguageExample>();
for (const example of [...CASH_NATURAL_LANGUAGE_EXAMPLES, ...CASH_NATURAL_LANGUAGE_EXPANDED_EXAMPLES]) {
  const key = normalize(example.input);
  if (!SOURCE_INDEX.has(key)) SOURCE_INDEX.set(key, example);
}

const TRANSFORMS: Array<(value: string) => string> = [
  value => `seguinte, ${value}`,
  value => `ó, ${value}`,
  value => `só uma coisa: ${value}`,
  value => `pra eu conferir, ${value}`,
  value => `quando puder, ${value}`,
  value => `faz um favor, ${value}`,
  value => `${value} aí pra mim`,
  value => `${value}, por gentileza`,
  value => `ei, ${value}`,
  value => `me tira uma dúvida: ${value}`,
  value => `deixa eu ver uma coisa: ${value}`,
  value => `só pra confirmar, ${value}`
];

const SOURCE_EXAMPLES = [...SOURCE_INDEX.values()];

export const CASH_NATURAL_LANGUAGE_COLLOQUIAL_EXAMPLES: CashNaturalLanguageExample[] = SOURCE_EXAMPLES.map(
  (example, index) => ({
    input: TRANSFORMS[index % TRANSFORMS.length](example.input),
    intent: example.intent,
    canonical: example.canonical
  })
);

const COLLOQUIAL_INDEX = new Map<string, CashNaturalLanguageExample>();
for (const example of CASH_NATURAL_LANGUAGE_COLLOQUIAL_EXAMPLES) {
  const key = normalize(example.input);
  if (!COLLOQUIAL_INDEX.has(key)) COLLOQUIAL_INDEX.set(key, example);
}

export function matchCashNaturalLanguageColloquialExample(input: string): CashNaturalLanguageExample | null {
  return COLLOQUIAL_INDEX.get(normalize(input)) ?? null;
}

export const CASH_NATURAL_LANGUAGE_COLLOQUIAL_EXAMPLE_COUNT = COLLOQUIAL_INDEX.size;
export const CASH_NATURAL_LANGUAGE_PREVIOUS_UNIQUE_COUNT = SOURCE_INDEX.size;
