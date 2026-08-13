import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isInternalRequest } from '../platform/security/internal-auth.js';
import {
  resolveTenantContext,
  suppliedCompanyId,
  tenantErrorStatus
} from '../platform/security/tenant-context.js';
import { billingService } from './billing.service.js';

function failure(reply: FastifyReply, error: unknown) {
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

async function tenant(
  request: FastifyRequest,
  reply: FastifyReply,
  allowLegacyInternalTenant: boolean,
  work: (companyId: string) => Promise<unknown>
) {
  try {
    const context = await resolveTenantContext(request, { allowLegacyInternalTenant });
    return reply.send(await work(context.companyId));
  } catch (error) {
    return failure(reply, error);
  }
}

export async function registerBillingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/internal/platform/billing/catalog', async (request, reply) => {
    try {
      await resolveTenantContext(request);
      return reply.send({ data: await billingService.catalog() });
    } catch (error) {
      return failure(reply, error);
    }
  });

  const subscription = (allowLegacy: boolean) => (request: FastifyRequest, reply: FastifyReply) =>
    tenant(request, reply, allowLegacy, async companyId => ({
      data: await billingService.subscriptionInfo(companyId)
    }));
  app.get('/internal/platform/billing/subscription', subscription(false));
  app.get('/internal/billing/subscription', subscription(true));

  const context = (allowLegacy: boolean) => (request: FastifyRequest, reply: FastifyReply) =>
    tenant(request, reply, allowLegacy, async companyId => ({
      data: await billingService.context(companyId)
    }));
  app.get('/internal/platform/billing/context', context(false));
  app.get('/internal/billing/context', context(true));

  const customer = (allowLegacy: boolean) => (request: FastifyRequest, reply: FastifyReply) =>
    tenant(request, reply, allowLegacy, async companyId => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const customerId = String(body.customer_id ?? '').trim();
      if (!customerId) throw new Error('BILLING_CUSTOMER_INVALID');
      await billingService.setStripeCustomer(companyId, customerId);
      return { ok: true };
    });
  app.post('/internal/platform/billing/customer', customer(false));
  app.post('/internal/billing/customer', customer(true));

  app.post('/internal/billing/stripe-event', async (request, reply) => {
    if (!isInternalRequest(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      return reply.send({ ok: true, ...(await billingService.applyStripeEvent(request.body ?? {})) });
    } catch (error) {
      return failure(reply, error);
    }
  });

  // O helper continua exportado implicitamente por compatibilidade de payload.
  void suppliedCompanyId;
}
