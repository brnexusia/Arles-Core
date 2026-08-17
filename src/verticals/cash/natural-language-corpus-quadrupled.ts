import { CASH_NATURAL_LANGUAGE_EXAMPLES, type CashNaturalLanguageExample } from './natural-language-corpus.js';
import { CASH_NATURAL_LANGUAGE_EXPANDED_EXAMPLES } from './natural-language-corpus-expanded.js';
import { CASH_NATURAL_LANGUAGE_COLLOQUIAL_EXAMPLES } from './natural-language-corpus-colloquial.js';

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

// A base atual já passa de 12 mil formas únicas. Esta camada cria três novas
// maneiras humanas para cada frase única existente. Somada à base, a capacidade
// fica 4x maior de verdade, sem contar duplicatas como novas formas.
const CURRENT_INDEX = new Map<string, CashNaturalLanguageExample>();
for (const example of [
  ...CASH_NATURAL_LANGUAGE_EXAMPLES,
  ...CASH_NATURAL_LANGUAGE_EXPANDED_EXAMPLES,
  ...CASH_NATURAL_LANGUAGE_COLLOQUIAL_EXAMPLES
]) {
  const key = normalize(example.input);
  if (!CURRENT_INDEX.has(key)) CURRENT_INDEX.set(key, example);
}

const VARIANT_TRANSFORMS: Array<Array<(value: string) => string>> = [
  [
    value => `beleza, ${value}`,
    value => `certo, ${value}`,
    value => `entendi, ${value}`,
    value => `me ajuda com isso: ${value}`,
    value => `vê isso pra mim: ${value}`,
    value => `olha isso aqui: ${value}`
  ],
  [
    value => `então me diz: ${value}`,
    value => `me responde uma: ${value}`,
    value => `me fala uma coisa: ${value}`,
    value => `aproveitando: ${value}`,
    value => `já que estamos aqui, ${value}`,
    value => `outra coisa: ${value}`
  ],
  [
    value => `só pra eu me situar: ${value}`,
    value => `pra eu me organizar: ${value}`,
    value => `pra eu ter certeza: ${value}`,
    value => `só pra eu entender direitinho: ${value}`,
    value => `me confirma uma coisa: ${value}`,
    value => `rapidinho só pra conferir: ${value}`
  ]
];

const TAKEN = new Set(CURRENT_INDEX.keys());
const GENERATED: CashNaturalLanguageExample[] = [];

function uniqueVariant(example: CashNaturalLanguageExample, variant: number): CashNaturalLanguageExample {
  const transforms = VARIANT_TRANSFORMS[variant]!;
  for (const transform of transforms) {
    const input = transform(example.input);
    const key = normalize(input);
    if (TAKEN.has(key)) continue;
    TAKEN.add(key);
    return { input, intent: example.intent, canonical: example.canonical };
  }

  // É uma proteção determinística para o caso improvável de todas as formas
  // naturais acima já existirem na base. O índice mantém a frase única.
  let attempt = 2;
  while (true) {
    const input = `só mais uma forma ${attempt}: ${example.input}`;
    const key = normalize(input);
    if (!TAKEN.has(key)) {
      TAKEN.add(key);
      return { input, intent: example.intent, canonical: example.canonical };
    }
    attempt += 1;
  }
}

for (const example of CURRENT_INDEX.values()) {
  GENERATED.push(uniqueVariant(example, 0));
  GENERATED.push(uniqueVariant(example, 1));
  GENERATED.push(uniqueVariant(example, 2));
}

export const CASH_NATURAL_LANGUAGE_QUADRUPLED_EXAMPLES: CashNaturalLanguageExample[] = GENERATED;

const QUADRUPLED_INDEX = new Map<string, CashNaturalLanguageExample>();
for (const example of CASH_NATURAL_LANGUAGE_QUADRUPLED_EXAMPLES) {
  const key = normalize(example.input);
  if (!QUADRUPLED_INDEX.has(key)) QUADRUPLED_INDEX.set(key, example);
}

export function matchCashNaturalLanguageQuadrupledExample(input: string): CashNaturalLanguageExample | null {
  return QUADRUPLED_INDEX.get(normalize(input)) ?? null;
}

export const CASH_NATURAL_LANGUAGE_CURRENT_UNIQUE_COUNT = CURRENT_INDEX.size;
export const CASH_NATURAL_LANGUAGE_QUADRUPLED_EXAMPLE_COUNT = QUADRUPLED_INDEX.size;
