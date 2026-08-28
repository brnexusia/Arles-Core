import type { VerticalContext, VerticalResult } from '../vertical.js';
import { handleCashPendingAiDeletion } from './ai-deletion-executor.js';
import { handleCashPendingDeletion } from './deletion.js';
import { handleCashPendingEditInteraction } from './pending-edit-interaction.js';
import { handleCashPendingPocketClosing } from './pocket-closing-flow.js';
import { handleCashPendingPocketTransfer } from './pocket-transfer.js';

/**
 * Executa um estado pendente usando um sinal já decidido semanticamente pela IA.
 * Os handlers antigos continuam responsáveis apenas pela operação/validação do
 * estado salvo; eles não recebem mais a frase livre do usuário.
 */
export async function executeCashPendingSemanticDecision(
  context: VerticalContext,
  decision: 'confirm' | 'cancel'
): Promise<VerticalResult | null> {
  const canonicalContext: VerticalContext = {
    ...context,
    combinedText: decision === 'confirm' ? 'sim' : 'não'
  };

  return (await handleCashPendingAiDeletion(canonicalContext))
    ?? (await handleCashPendingPocketClosing(canonicalContext))
    ?? (await handleCashPendingPocketTransfer(canonicalContext))
    ?? (await handleCashPendingDeletion(canonicalContext))
    ?? (await handleCashPendingEditInteraction(canonicalContext))
    ?? null;
}
