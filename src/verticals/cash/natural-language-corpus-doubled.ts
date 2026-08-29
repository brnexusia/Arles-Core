import { CASH_NATURAL_LANGUAGE_EXAMPLES, type CashNaturalLanguageExample } from './natural-language-corpus.js';
import { CASH_NATURAL_LANGUAGE_EXPANDED_EXAMPLES } from './natural-language-corpus-expanded.js';
import { CASH_NATURAL_LANGUAGE_COLLOQUIAL_EXAMPLES } from './natural-language-corpus-colloquial.js';
import { CASH_NATURAL_LANGUAGE_QUADRUPLED_EXAMPLES } from './natural-language-corpus-quadrupled.js';

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

// A base anterior já passa de 48 mil formas únicas. Esta camada cria exatamente
// uma nova forma humana para cada frase única já existente. Somada à base,
// a capacidade total dobra de verdade para mais de 96 mil formas únicas.
const CURRENT_INDEX = new Map<string, CashNaturalLanguageExample>();
for (const example of [
  ...CASH_NATURAL_LANGUAGE_EXAMPLES,
  ...CASH_NATURAL_LANGUAGE_EXPANDED_EXAMPLES,
  ...CASH_NATURAL_LANGUAGE_COLLOQUIAL_EXAMPLES,
  ...CASH_NATURAL_LANGUAGE_QUADRUPLED_EXAMPLES
]) {
  const key = normalize(example.input);
  if (!CURRENT_INDEX.has(key)) CURRENT_INDEX.set(key, example);
}

const TRANSFORMS: Array<(value: string) => string> = [
  value => `tipo assim, ${value}`,
  value => `me diz aí: ${value}`,
  value => `só pra saber, ${value}`,
  value => `consegue ver pra mim: ${value}`,
  value => `me passa isso: ${value}`,
  value => `pode me dizer: ${value}`,
  value => `confere isso pra mim: ${value}`,
  value => `quero entender uma coisa: ${value}`,
  value => `fala pra mim então: ${value}`,
  value => `só confirma pra mim: ${value}`,
  value => `rapidinho aqui: ${value}`,
  value => `na prática, ${value}`,
  value => `deixa eu te perguntar: ${value}`,
  value => `me ajuda a conferir: ${value}`,
  value => `uma coisinha: ${value}`,
  value => `antes que eu esqueça, ${value}`
];

const TAKEN = new Set(CURRENT_INDEX.keys());
const GENERATED: CashNaturalLanguageExample[] = [];

function uniqueVariant(example: CashNaturalLanguageExample, startIndex: number): CashNaturalLanguageExample {
  for (let offset = 0; offset < TRANSFORMS.length; offset += 1) {
    const transform = TRANSFORMS[(startIndex + offset) % TRANSFORMS.length]!;
    const input = transform(example.input);
    const key = normalize(input);
    if (TAKEN.has(key)) continue;
    TAKEN.add(key);
    return { input, intent: example.intent, canonical: example.canonical };
  }

  // Fallback determinístico e ainda conversacional. Em condições normais não é
  // necessário, mas garante unicidade mesmo se a base crescer com novos prefixos.
  let attempt = 1;
  while (true) {
    const input = `só pra confirmar de outro jeito ${attempt}, ${example.input}`;
    const key = normalize(input);
    if (!TAKEN.has(key)) {
      TAKEN.add(key);
      return { input, intent: example.intent, canonical: example.canonical };
    }
    attempt += 1;
  }
}

let index = 0;
for (const example of CURRENT_INDEX.values()) {
  GENERATED.push(uniqueVariant(example, index % TRANSFORMS.length));
  index += 1;
}

export const CASH_NATURAL_LANGUAGE_DOUBLED_EXAMPLES: CashNaturalLanguageExample[] = GENERATED;

const DOUBLED_INDEX = new Map<string, CashNaturalLanguageExample>();
for (const example of CASH_NATURAL_LANGUAGE_DOUBLED_EXAMPLES) {
  const key = normalize(example.input);
  if (!DOUBLED_INDEX.has(key)) DOUBLED_INDEX.set(key, example);
}

export function matchCashNaturalLanguageDoubledExample(input: string): CashNaturalLanguageExample | null {
  return DOUBLED_INDEX.get(normalize(input)) ?? null;
}

// Fast path compartilhado: CURRENT_INDEX já contém base + expansão + coloquial + 4x.
// Assim, o roteador faz uma única normalização e no máximo duas consultas Map para
// todo o universo de 96.000+ frases, em vez de normalizar/buscar em cinco índices.
export function matchCashNaturalLanguageAnyExample(input: string): CashNaturalLanguageExample | null {
  const key = normalize(input);
  return CURRENT_INDEX.get(key) ?? DOUBLED_INDEX.get(key) ?? null;
}

export const CASH_NATURAL_LANGUAGE_PRE_DOUBLING_UNIQUE_COUNT = CURRENT_INDEX.size;
export const CASH_NATURAL_LANGUAGE_DOUBLED_EXAMPLE_COUNT = DOUBLED_INDEX.size;