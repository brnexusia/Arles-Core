import type { FastifyInstance } from 'fastify';
import { registerAuthRoutes } from './auth/auth.routes.js';
import { registerBillingRoutes } from './billing/billing.routes.js';
import { registerAdminRoutes } from './admin/admin.routes.js';
import { registerPlatformRoutes } from './platform/platform.routes.js';
import { moduleRegistry } from './platform/modules/registry.js';
import { deliveryModule } from './verticals/delivery/module.js';
import { beautyModule } from './verticals/beauty/module.js';
import { registerVertical } from './verticals/router.js';
import type { VerticalModule as LegacyVerticalModule } from './verticals/vertical.js';
import type { VerticalModule as PlatformVerticalModule } from './platform/modules/contract.js';

let composed = false;

function platformAdapter(module: LegacyVerticalModule): PlatformVerticalModule {
  return {
    key: module.id,
    metadata: {
      name: module.name,
      version: module.version,
      description: `Modulo ${module.name} para a plataforma Arles.`
    },
    capabilities: [
      { key: `vertical.${module.id}`, required: true },
      ...module.capabilities.map(key => ({ key }))
    ],
    conversationHandler: module,
    registerRoutes: module.registerRoutes
  };
}

export async function composeApplication(app: FastifyInstance): Promise<void> {
  if (!composed) {
    for (const vertical of [deliveryModule, beautyModule]) {
      registerVertical(vertical);
      moduleRegistry.register(platformAdapter(vertical));
    }
    composed = true;
  }

  await registerAuthRoutes(app);
  await registerBillingRoutes(app);
  await registerAdminRoutes(app);
  await registerPlatformRoutes(app);

  for (const module of moduleRegistry.list()) {
    await module.registerRoutes?.(app);
  }
}
