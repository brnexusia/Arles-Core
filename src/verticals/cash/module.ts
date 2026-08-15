import type { VerticalModule } from '../vertical.js';
import { cashHandler } from './handler.js';
import { cashReports } from './reports.js';
import { registerCashRoutes } from './routes.js';

export const cashModule: VerticalModule = {
  id: 'cash',
  name: 'Arles Cash',
  version: '1.0.0',
  capabilities: ['cash.transactions', 'cash.summaries', 'cash.settings'],
  handle: context => cashHandler.handle(context),
  registerRoutes: registerCashRoutes,
  jobs: {
    'cash.weekly-summary': context => cashReports.weekly(context),
    'cash.monthly-summary': context => cashReports.monthly(context)
  },
  onboardingSteps: [
    {
      key: 'cash.whatsapp',
      scope: 'capability',
      capabilityKey: 'cash.transactions',
      title: 'Conectar WhatsApp',
      order: 10
    }
  ],
  ui: {
    entry: 'cash',
    navigation: [
      { key: 'dashboard', label: 'Resumo', icon: 'home', order: 10 },
      { key: 'transactions', label: 'Lançamentos', icon: 'list', order: 20 },
      { key: 'settings', label: 'Ajustes', icon: 'settings', order: 30 }
    ]
  }
};

