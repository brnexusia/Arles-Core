import type { VerticalModule, VerticalResult } from '../vertical.js';
import { cashAccessHandler } from './access-handler.js';
import { handleCashPendingAiDeletion } from './ai-deletion-executor.js';
import {
  rememberCashAssistantResult,
  rememberCashUserMessage
} from './conversation-memory.js';
import { handleCashPendingDeletion } from './deletion.js';
import { handleCashPendingEditInteraction } from './pending-edit-interaction.js';
import { handleCashPendingPocketClosing } from './pocket-closing-flow.js';
import { handleCashPendingPocketTransfer } from './pocket-transfer.js';
import { cashReports } from './reports.js';
import { formatCashUserResponse } from './response-format.js';
import { registerCashRoutes } from './routes.js';

const SHORT_PENDING_REPLIES = new Set([
  'sim',
  's',
  'não',
  'nao',
  'n',
  'confirmo',
  'confirma',
  'pode',
  'pode fazer',
  'pode apagar',
  'pode excluir',
  'isso',
  'isso mesmo',
  'correto',
  'certo',
  'ok',
  'cancelar',
  'cancela',
  'cancelar edição',
  'cancelar edicao',
  'deixa pra lá',
  'deixa pra la'
]);

function isShortPendingReply(value: string): boolean {
  return SHORT_PENDING_REPLIES.has(String(value ?? '').trim().toLocaleLowerCase('pt-BR'));
}

async function handleWithMemory(context: Parameters<typeof cashAccessHandler.handle>[0]): Promise<VerticalResult | null> {
  await rememberCashUserMessage(context);
  const raw = await cashAccessHandler.handle(context);
  const formatted = await formatCashUserResponse(context, raw);
  await rememberCashAssistantResult(context, formatted);
  return formatted;
}

async function handlePendingWithMemory(
  context: Parameters<NonNullable<VerticalModule['handlePendingInteraction']>>[0]
): Promise<VerticalResult | undefined> {
  await rememberCashUserMessage(context);

  // Estados pendentes só podem interceptar respostas curtas e inequívocas. Qualquer
  // frase normal segue para a IA contextual, que enxerga as últimas 30 mensagens.
  if (!isShortPendingReply(context.combinedText)) return undefined;

  const result = (await handleCashPendingAiDeletion(context))
    ?? (await handleCashPendingPocketClosing(context))
    ?? (await handleCashPendingPocketTransfer(context))
    ?? (await handleCashPendingDeletion(context))
    ?? (await handleCashPendingEditInteraction(context));

  if (result) await rememberCashAssistantResult(context, result);
  return result;
}

export const cashModule: VerticalModule = {
  id: 'cash',
  name: 'Arles Cash',
  version: '2.7.0',
  capabilities: [
    'cash.transactions',
    'cash.summaries',
    'cash.settings',
    'cash.pockets',
    'cash.receivables',
    'cash.pocket_snapshots',
    'cash.forecasts',
    'cash.schedules',
    'cash.conversation_memory'
  ],
  handle: handleWithMemory,
  handlePendingInteraction: handlePendingWithMemory,
  registerRoutes: registerCashRoutes,
  jobs: {
    'cash.weekly-summary': context => cashReports.weekly(context),
    'cash.monthly-summary': context => cashReports.monthly(context),
    'cash.trial-day5': context => cashReports.trialDay5(context),
    'cash.trial-day7': context => cashReports.trialDay7(context),
    'cash.trial-expired': context => cashReports.trialExpired(context)
  },
  onboardingSteps: [],
  ui: {
    entry: 'cash',
    navigation: [
      { key: 'dashboard', label: 'Resumo', icon: 'home', order: 10 },
      { key: 'transactions', label: 'Lançamentos', icon: 'list', order: 20 },
      { key: 'settings', label: 'Ajustes', icon: 'settings', order: 30 }
    ]
  }
};
