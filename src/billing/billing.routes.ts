import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { billingService } from './billing.service.js';

function authorized(request: FastifyRequest): boolean {
  if (!env.internalApiKey) return false;
  const direct = String(request.headers['x-arles-key'] ?? '').trim();
  const auth = String(request.headers.authorization ?? '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  return direct === env.internalApiKey || auth === env.internalApiKey;
}

function companyIdFrom(request: FastifyRequest): string {
  const query = (request.query ?? {}) as Record<string, unknown>;
  const body = (request.body ?? {}) as Record<string, unknown>;
  return String(query.company_id ?? body.company_id ?? '').trim();
}

function failure(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = /NOT_FOUND/.test(message) ? 404 : /INVALID/.test(message) ? 400 : 500;
  return reply.code(status).send({ error: message });
}

export async function registerBillingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/internal/billing/subscription', async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      return reply.send({
        data: await billingService.subscriptionInfo(companyIdFrom(request))
      });
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get('/internal/billing/context', async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      return reply.send({
        data: await billingService.context(companyIdFrom(request))
      });
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post('/internal/billing/customer', async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const body = (request.body ?? {}) as any;
    const companyId = companyIdFrom(request);
    const customerId = String(body.customer_id ?? '').trim();
    if (!companyId || !customerId) {
      return reply.code(400).send({ error: 'company_id e customer_id obrigatórios' });
    }
    await billingService.setStripeCustomer(companyId, customerId);
    return reply.send({ ok: true });
  });

  app.post('/internal/billing/stripe-event', async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      return reply.send({
        ok: true,
        ...(await billingService.applyStripeEvent(request.body ?? {}))
      });
    } catch (error) {
      return failure(reply, error);
    }
  });
}
