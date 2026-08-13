import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import { deliveryPostSaleService } from './post-sale.service.js';
import { updatePaymentStatus } from './repository.js';

function authorized(request: FastifyRequest): boolean {
  if (!env.internalApiKey) return false;
  const direct = String(request.headers['x-arles-key'] ?? '').trim();
  const auth = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  return direct === env.internalApiKey || auth === env.internalApiKey;
}

export async function registerDeliveryEventRoutes(app: FastifyInstance): Promise<void> {
  const orderStatus = async (request: any, reply: any) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const companyId = String(body.company_id ?? body.companyId ?? '').trim();
    const orderId = String(body.order_id ?? body.orderId ?? '').trim();
    const status = String(body.status ?? '').trim();
    if (!companyId || !orderId || !status) {
      return reply.code(400).send({ error: 'company_id, order_id e status são obrigatórios' });
    }
    const result = await deliveryPostSaleService.updateAndNotify({ companyId, orderId, status });
    return reply.send({ ok: true, ...result });
  };

  app.post('/internal/verticals/delivery/events/order-status', orderStatus);
  app.post('/events/order-status', orderStatus);
  app.post('/webhooks/arles-delivery-events', orderStatus);

  const paymentStatus = async (request: any, reply: any) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const companyId = String(body.company_id ?? body.companyId ?? '').trim();
    const orderId = String(body.order_id ?? body.orderId ?? '').trim();
    const status = String(body.payment_status ?? body.paymentStatus ?? '').trim().toLowerCase();
    const allowed = new Set(['pending', 'pending_approval', 'approved', 'rejected']);
    if (!companyId || !orderId || !allowed.has(status)) {
      return reply.code(400).send({ error: 'company_id, order_id e payment_status válido são obrigatórios' });
    }
    const updated = await updatePaymentStatus({
      companyId,
      orderId,
      paymentStatus: status as 'pending' | 'pending_approval' | 'approved' | 'rejected'
    });
    if (!updated) return reply.code(404).send({ error: 'order_not_found' });
    return reply.send({ ok: true, payment_status: status });
  };

  app.post('/internal/verticals/delivery/events/payment-status', paymentStatus);
  app.post('/events/payment-status', paymentStatus);
}
