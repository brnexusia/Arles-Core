import type { VerticalModule } from '../vertical.js';
import { assistHandler } from './handler.js';
import { registerAssistRoutes } from './routes.js';

export const assistModule:VerticalModule={
  id:'assist',
  name:'Arles Assist',
  version:'0.1.0',
  capabilities:[
    'assist.services',
    'assist.import',
    'assist.quotes',
    'assist.orders',
    'assist.customers',
    'assist.status',
    'assist.ai_triage'
  ],
  handle:context=>assistHandler.handle(context),
  registerRoutes:registerAssistRoutes
};
