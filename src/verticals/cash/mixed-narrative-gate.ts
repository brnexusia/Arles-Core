import { db } from '../../infrastructure/db.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import { isCashMixedFinancialNarrative } from './conversation-corpus.js';
import { preprocessCashInput } from './smart-input.js';

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

async function cleanupLegacyMixedSchedules(context: VerticalContext): Promise<number> {
  // Versões antigas do roteador podiam transformar a narrativa inteira em uma única
  // previsão. O scheduler grava source_message truncado em 1000 caracteres, então ao
  // reenviar a mesma narrativa podemos desativar somente os agendamentos originados
  // exatamente daquele texto, sem tocar em previsões legítimas do usuário.
  const source = context.combinedText.slice(0, 1000);
  const result = await db.query(
    `update cash_scheduled_forecasts
     set active=false,updated_at=now()
     where company_id=$1
       and active=true
       and source_message=$2
     returning id`,
    [context.company.id, source]
  );
  return Number(result.rowCount ?? 0);
}

function appendCleanupNotice(result: VerticalResult, removed: number): VerticalResult {
  if (removed <= 0) return result;
  return {
    ...result,
    actions: [
      ...result.actions,
      {
        type: 'text',
        text: removed === 1
          ? '🧹 Também removi a previsão antiga que havia sido criada incorretamente a partir dessa mesma mensagem.'
          : `🧹 Também removi ${removed} previsões antigas criadas incorretamente a partir dessa mesma mensagem.`
      }
    ]
  };
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

  const removedLegacySchedules = await cleanupLegacyMixedSchedules(context);
  const prepared = await preprocessCashInput(context);
  if (prepared?.kind === 'result') {
    return appendCleanupNotice(prepared.result, removedLegacySchedules);
  }

  // Nunca deixa uma narrativa reconhecidamente mista cair no scheduler como uma
  // previsão única. Se a decomposição não for segura, é melhor pedir divisão do texto
  // do que registrar/agendar um valor incorreto.
  return text([
    'Identifiquei vários fatos, previsões e hipóteses na mesma mensagem, mas não consegui separar todos com segurança.',
    'Não registrei nem agendei nada.',
    removedLegacySchedules > 0
      ? `Removi ${removedLegacySchedules} previsão${removedLegacySchedules === 1 ? '' : 'ões'} antiga${removedLegacySchedules === 1 ? '' : 's'} criada${removedLegacySchedules === 1 ? '' : 's'} incorretamente a partir desse mesmo texto.`
      : '',
    '',
    'Pode reenviar em 2 ou 3 blocos menores; eu separo os movimentos reais das previsões sem misturar os valores.'
  ].filter(Boolean).join('\n'));
}
