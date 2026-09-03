import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { enforceRateLimit } from '../security/rate-limit.js';
import { trackBeautyAsaasWebhook } from '../tracking/meta.service.js';
import { billingService } from './billing.service.js';
import { beautyAsaasService } from './beauty-asaas.service.js';

function authorized(request: FastifyRequest): boolean {
  if (!env.internalApiKey) return false;
  const direct = String(request.headers['x-arles-key'] ?? '').trim();
  const auth = String(request.headers.authorization ?? '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  return direct === env.internalApiKey || auth === env.internalApiKey;
}

function asaasAuthorized(request: FastifyRequest): boolean {
  const expected = env.asaasWebhookToken;
  const received = String(request.headers['asaas-access-token'] ?? '').trim();
  if (!expected || !received) return false;
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(received, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function companyIdFrom(request: FastifyRequest): string {
  const query = (request.query ?? {}) as Record<string, unknown>;
  const body = (request.body ?? {}) as Record<string, unknown>;
  return String(query.company_id ?? body.company_id ?? '').trim();
}

function failure(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = message === 'RATE_LIMITED' ? 429 : /NOT_FOUND/.test(message) ? 404 : /INVALID|REQUIRED|ONLY/.test(message) ? 400 : /NOT_CONFIGURED/.test(message) ? 503 : 500;
  return reply.code(status).send({ error: message === 'RATE_LIMITED' ? 'RATE_LIMITED' : message });
}

async function billingLimit(reply: FastifyReply, companyId: string, operation: string, limit: number, windowSeconds: number) {
  if (!companyId) throw new Error('COMPANY_REQUIRED');
  await enforceRateLimit({ scope: `billing:beauty:${operation}`, limit, windowSeconds, identity: companyId }, reply);
}

export async function registerBillingRoutes(app: FastifyInstance): Promise<void> {
  // Stripe legacy routes stay untouched for Delivery/other verticals.
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

  app.post('/internal/billing/customer', { bodyLimit: 32 * 1024 }, async (request, reply) => {
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

  app.post('/internal/billing/stripe-event', { bodyLimit: 256 * 1024 }, async (request, reply) => {
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

  // Beauty: single R$49,90 plan using Pix Automático / recurring Pix in Asaas.
  app.get('/internal/billing/beauty', async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const companyId = companyIdFrom(request);
      await billingLimit(reply, companyId, 'info', 120, 60);
      return reply.send({ data: await beautyAsaasService.info(companyId) });
    } catch (error) { return failure(reply, error); }
  });

  app.post('/internal/billing/beauty/activate', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const body = (request.body ?? {}) as any;
      const companyId = companyIdFrom(request);
      await billingLimit(reply, companyId, 'activate', 5, 60 * 60);
      return reply.send({ data: await beautyAsaasService.startActivation(companyId, { cpf_cnpj: body.cpf_cnpj }) });
    } catch (error) { return failure(reply, error); }
  });

  app.post('/internal/billing/beauty/refresh', { bodyLimit: 8 * 1024 }, async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const companyId = companyIdFrom(request);
      await billingLimit(reply, companyId, 'refresh', 30, 60);
      return reply.send({ data: await beautyAsaasService.refresh(companyId) });
    } catch (error) { return failure(reply, error); }
  });

  app.post('/internal/billing/beauty/cancel', { bodyLimit: 8 * 1024 }, async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const companyId = companyIdFrom(request);
      await billingLimit(reply, companyId, 'cancel', 3, 60 * 60);
      return reply.send({ data: await beautyAsaasService.cancel(companyId) });
    } catch (error) { return failure(reply, error); }
  });

  app.post('/webhooks/asaas', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    if (!asaasAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const payload = request.body ?? {};
      const result = await beautyAsaasService.applyWebhook(payload);
      if (!result.duplicate && result.companyId) {
        void trackBeautyAsaasWebhook(result.companyId, payload).catch(error => {
          request.log.error({ err: error, companyId: result.companyId }, 'Falha enviando conversão Beauty à Meta');
        });
      }
      return reply.code(200).send({ ok: true, duplicate: result.duplicate });
    } catch (error) {
      request.log.error({ err: error }, 'Falha processando webhook Asaas');
      return reply.code(500).send({ error: 'webhook_processing_failed' });
    }
  });
}
