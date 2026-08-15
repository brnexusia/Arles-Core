import type { FastifyInstance } from 'fastify';
import { registerAuthRoutes } from './auth/auth.routes.js';
import { registerBillingRoutes } from './billing/billing.routes.js';
import { registerAdminRoutes } from './admin/admin.routes.js';
import { registerPlatformRoutes } from './platform/platform.routes.js';
import { moduleRegistry } from './platform/modules/registry.js';
import { deliveryModule } from './verticals/delivery/module.js';
import { beautyModule } from './verticals/beauty/module.js';
import { cashModule } from './verticals/cash/module.js';
import { registerBuiltInVerticals } from './verticals/index.js';
import type { VerticalModule as LegacyVerticalModule } from './verticals/vertical.js';
import type { VerticalModule as PlatformVerticalModule } from './platform/modules/contract.js';

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
    registerRoutes: module.registerRoutes,
    jobs: module.jobs,
    onboardingSteps: module.onboardingSteps,
    ui: module.ui
  };
}

const builtInPlatformModules = [deliveryModule, beautyModule, cashModule];

export function registerBuiltInPlatformModules(): void {
  for (const vertical of builtInPlatformModules) {
    if (!moduleRegistry.get(vertical.id)) {
      moduleRegistry.register(platformAdapter(vertical));
    }
  }
}

export async function composeApplication(app: FastifyInstance): Promise<void> {
  registerBuiltInPlatformModules();

  await registerAuthRoutes(app);
  await registerBillingRoutes(app);
  await registerAdminRoutes(app);
  await registerPlatformRoutes(app);

  // A rota conversacional usada pelo Engine continua registrada pelo caminho legado
  // conhecido e estável do Delivery. Isso evita que a composição de painel interfira
  // no roteamento de mensagens WhatsApp.
  await registerBuiltInVerticals(app);
}
