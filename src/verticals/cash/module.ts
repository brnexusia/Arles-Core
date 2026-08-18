import type { VerticalModule } from '../vertical.js';
import { cashAccessHandler } from './access-handler.js';
import { handleCashPendingConfirmation } from './confirmation.js';
import { handleCashPendingDeletion } from './deletion.js';
import { handleCashPendingEditInteraction } from './pending-edit-interaction.js';
import { handleCashPendingPocketTransfer } from './pocket-transfer.js';
import { cashReports } from './reports.js';
import { formatCashUserResponse } from './response-format.js';
import { registerCashRoutes } from './routes.js';

export const cashModule: VerticalModule = {
  id: 'cash',
  name: 'Arles Cash',
  version: '2.4.0',
  capabilities: [
    'cash.transactions',
    'cash.summaries',
    'cash.settings',
    'cash.pockets',
    'cash.receivables',
    'cash.forecasts',
    'cash.schedules'
  ],
  handle: async context => formatCashUserResponse(context, await cashAccessHandler.handle(context)),
  handlePendingInteraction: async context =>
    (await handleCashPendingPocketTransfer(context))
      ?? (await handleCashPendingDeletion(context))
      ?? (await handleCashPendingConfirmation(context))
      ?? (await handleCashPendingEditInteraction(context)),
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
