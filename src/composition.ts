import type { FastifyInstance } from 'fastify';
import { registerAuthRoutes } from './auth/auth.routes.js';
import { registerBillingRoutes } from './billing/billing.routes.js';
import { registerPlatformRoutes } from './platform/platform.routes.js';
import { moduleRegistry } from './platform/modules/registry.js';
import { deliveryModule } from './verticals/delivery/module.js';

let composed = false;

export async function composeApplication(app: FastifyInstance): Promise<void> {
  if (!composed) {
    moduleRegistry.register(deliveryModule);
    composed = true;
  }

  await registerAuthRoutes(app);
  await registerBillingRoutes(app);
  await registerPlatformRoutes(app);

  for (const module of moduleRegistry.list()) {
    await module.registerRoutes?.(app);
  }
}
