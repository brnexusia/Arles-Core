import type { VerticalContext, VerticalResult } from '../vertical.js';
import { isCashMixedFinancialNarrative } from './conversation-corpus.js';
import { preprocessCashInput } from './smart-input.js';

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

/**
 * Narrativas financeiras longas podem misturar fatos já ocorridos, contas futuras,
 * recorrências, estimativas e hipóteses. Elas precisam ser decompostas ANTES do
 * scheduler/projection, senão uma expressão como "todo dia 10" pode capturar a
 * mensagem inteira e usar um valor completamente diferente como previsão.
 */
export async function handleCashMixedNarrativeGate(
  context: VerticalContext
): Promise<VerticalResult | null> {
  if (!isCashMixedFinancialNarrative(context.combinedText)) return null;

  const prepared = await preprocessCashInput(context);
  if (prepared?.kind === 'result') return prepared.result;

  // Nunca deixa uma narrativa reconhecidamente mista cair no scheduler como uma
  // previsão única. Se a decomposição não for segura, é melhor pedir divisão do texto
  // do que registrar/agendar um valor incorreto.
  return text([
    'Identifiquei vários fatos, previsões e hipóteses na mesma mensagem, mas não consegui separar todos com segurança.',
    'Não registrei nem agendei nada.',
    '',
    'Pode reenviar em 2 ou 3 blocos menores; eu separo os movimentos reais das previsões sem misturar os valores.'
  ].join('\n'));
}
