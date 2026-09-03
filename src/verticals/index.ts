import type { FastifyInstance } from 'fastify';
import { deliveryModule } from './delivery/module.js';
import { beautyModule } from './beauty/module.js';
import { cashModule } from './cash/module.js';
import { assistModule } from './assist/module.js';
import { getVerticalModule, registerVertical } from './router.js';

const builtInModules = [deliveryModule, beautyModule, cashModule, assistModule];

export async function registerBuiltInVerticals(app?: FastifyInstance): Promise<void> {
  for (const module of builtInModules) {
    if (!getVerticalModule(module.id)) registerVertical(module);
    if (app && module.registerRoutes) await module.registerRoutes(app);
  }
}
