import type { VerticalModule, VerticalResult } from '../vertical.js';
import { cashAccessHandler } from './access-handler.js';
import {
  rememberCashAssistantResult,
  rememberCashUserMessage
} from './conversation-memory.js';
import { cashReports } from './reports.js';
import { formatCashUserResponse } from './response-format.js';
import { registerCashRoutes } from './routes.js';

async function handleWithMemory(context: Parameters<typeof cashAccessHandler.handle>[0]): Promise<VerticalResult | null> {
  await rememberCashUserMessage(context);
  const raw = await cashAccessHandler.handle(context);
  const formatted = await formatCashUserResponse(context, raw);
  await rememberCashAssistantResult(context, formatted);
  return formatted;
}

export const cashModule: VerticalModule = {
  id: 'cash',
  name: 'Arles Cash',
  version: '2.8.0',
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
  // Não existe mais interceptação textual por listas de palavras antes da IA.
  // Confirmações, cancelamentos e respostas curtas também passam pela camada
  // contextual do GPT-5 nano e só então chegam aos executores técnicos.
  handle: handleWithMemory,
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
