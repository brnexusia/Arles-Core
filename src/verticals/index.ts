import type { FastifyInstance } from 'fastify';
import { deliveryModule } from './delivery/module.js';
import { getVerticalModule, registerVertical } from './router.js';

const builtInModules = [deliveryModule];

export async function registerBuiltInVerticals(app?: FastifyInstance): Promise<void> {
  for (const module of builtInModules) {
    if (!getVerticalModule(module.id)) registerVertical(module);
    if (app && module.registerRoutes) await module.registerRoutes(app);
  }
}
