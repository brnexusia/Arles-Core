import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveTenantContext, tenantErrorStatus } from './security/tenant-context.js';
import { platformService } from './platform.service.js';

type TenantHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
  companyId: string
) => Promise<unknown>;

function errorReply(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const tenantStatus = tenantErrorStatus(error);
  const status = tenantStatus !== 500
    ? tenantStatus
    : /NOT_FOUND/.test(message)
      ? 404
      : /INVALID/.test(message)
        ? 400
        : 500;
  return reply.code(status).send({ error: message });
}

function tenantRoute(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  currentPath: string,
  legacyPaths: string[],
  handler: TenantHandler
) {
  const register = (url: string, allowLegacyInternalTenant: boolean) => app.route({
    method,
    url,
    handler: async (request, reply) => {
      try {
        const tenant = await resolveTenantContext(request, { allowLegacyInternalTenant });
        return await handler(request, reply, tenant.companyId);
      } catch (error) {
        return errorReply(reply, error);
      }
    }
  });
  register(currentPath, false);
  for (const path of legacyPaths) register(path, true);
}

export async function registerPlatformRoutes(app: FastifyInstance): Promise<void> {
  tenantRoute(app, 'GET', '/internal/platform/company', ['/internal/panel/company'],
    async (_request, reply, companyId) => {
      const [company, manifest] = await Promise.all([
        platformService.company(companyId),
        platformService.manifest(companyId)
      ]);
      return reply.send({ data: { ...company, ...manifest } });
    });

  tenantRoute(app, 'GET', '/internal/platform/capabilities', [],
    async (_request, reply, companyId) => reply.send({ data: await platformService.manifest(companyId) }));

  tenantRoute(app, 'GET', '/internal/platform/onboarding', [],
    async (_request, reply, companyId) => reply.send({ data: await platformService.onboarding(companyId) }));

  tenantRoute(app, 'POST', '/internal/platform/onboarding/complete', ['/internal/panel/onboarding/complete'],
    async (request, reply, companyId) => {
      const body = (request.body ?? {}) as { step_keys?: unknown[] };
      const steps = Array.isArray(body.step_keys) ? body.step_keys.map(String) : [];
      await platformService.completeOnboarding(companyId, steps);
      return reply.send({ ok: true });
    });

  tenantRoute(app, 'GET', '/internal/platform/customers', [],
    async (_request, reply, companyId) => reply.send({ data: await platformService.listCustomers(companyId) }));

  tenantRoute(app, 'PATCH', '/internal/platform/customers/:id', [],
    async (request, reply, companyId) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as Record<string, unknown>;
      return reply.send({
        ok: true,
        data: await platformService.updateCustomerNotes(companyId, id, String(body.notes ?? ''))
      });
    });

  tenantRoute(app, 'GET', '/internal/platform/settings', ['/internal/panel/settings'],
    async (_request, reply, companyId) => reply.send({ data: await platformService.settings(companyId) }));

  tenantRoute(app, 'PUT', '/internal/platform/settings', ['/internal/panel/settings'],
    async (request, reply, companyId) => reply.send({
      ok: true,
      data: await platformService.saveSettings(companyId, (request.body ?? {}) as Record<string, unknown>)
    }));

  tenantRoute(app, 'GET', '/internal/platform/channels/whatsapp', ['/internal/panel/whatsapp/status'],
    async (_request, reply, companyId) => reply.send(await platformService.channelStatus(companyId)));

  tenantRoute(app, 'POST', '/internal/platform/channels/whatsapp/connect', ['/internal/panel/whatsapp/connect'],
    async (_request, reply, companyId) => reply.send(await platformService.connectChannel(companyId)));

  tenantRoute(app, 'POST', '/internal/platform/channels/whatsapp/disconnect', ['/internal/panel/whatsapp/disconnect'],
    async (_request, reply, companyId) => reply.send(await platformService.disconnectChannel(companyId)));
}
