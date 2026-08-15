import type { VerticalModule } from '../vertical.js';
import { cashBroadHandler } from './broad-handler.js';
import { cashReports } from './reports.js';
import { registerCashRoutes } from './routes.js';

export const cashModule: VerticalModule = {
  id: 'cash',
  name: 'Arles Cash',
  version: '2.0.0',
  capabilities: ['cash.transactions', 'cash.summaries', 'cash.settings'],
  handle: context => cashBroadHandler.handle(context),
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
