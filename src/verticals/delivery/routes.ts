import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { panelService } from './panel.service.js';
import { menuAnalysisService } from './menu/analysis.service.js';
import { db } from '../../infrastructure/db.js';
import { isInternalRequest } from '../../platform/security/internal-auth.js';
import {
  resolveTenantContext,
  suppliedCompanyId,
  tenantErrorStatus
} from '../../platform/security/tenant-context.js';
import { deliveryPostSaleService } from './post-sale.service.js';
import { updatePaymentStatus } from './repository.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type TenantHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
  companyId: string
) => Promise<unknown>;

function fail(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : String(error || 'Erro interno');
  const tenantStatus = tenantErrorStatus(error);
  const status = tenantStatus !== 500
    ? tenantStatus
    : /não encontrad/i.test(message)
      ? 404
      : /inválid|obrigat|preço|mismatch/i.test(message)
        ? 400
        : 500;
  return reply.code(status).send({ error: message });
}

function registerTenantRoute(
  app: FastifyInstance,
  method: Method,
  currentPath: string,
  legacyPaths: string[],
  handler: TenantHandler
): void {
  const register = (url: string, allowLegacyInternalTenant: boolean) => {
    app.route({
      method,
      url,
      handler: async (request, reply) => {
        try {
          const tenant = await resolveTenantContext(request, { allowLegacyInternalTenant });
          return await handler(request, reply, tenant.companyId);
        } catch (error) {
          return fail(reply, error);
        }
      }
    });
  };
  register(currentPath, false);
  for (const path of legacyPaths) register(path, true);
}

export async function registerDeliveryRoutes(app: FastifyInstance): Promise<void> {
  registerTenantRoute(app, 'GET', '/internal/verticals/delivery/orders', ['/internal/panel/orders'],
    async (_request, reply, companyId) => reply.send({ data: await panelService.listOrders(companyId) }));

  registerTenantRoute(app, 'POST', '/internal/verticals/delivery/orders/:id/status', ['/internal/panel/orders/:id/status'],
    async (request, reply, companyId) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as Record<string, unknown>;
      const data = await panelService.updateOrderStatus(companyId, id, String(body.status ?? ''));
      return reply.send({ ok: true, data });
    });

  registerTenantRoute(app, 'POST', '/internal/verticals/delivery/orders/:id/payment', ['/internal/panel/orders/:id/payment'],
    async (request, reply, companyId) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as Record<string, unknown>;
      const data = await panelService.updateOrderPayment(
        companyId,
        id,
        String(body.payment_status ?? body.status ?? '')
      );
      return reply.send({ ok: true, data });
    });

  registerTenantRoute(app, 'GET', '/internal/verticals/delivery/customers', ['/internal/panel/customers'],
    async (_request, reply, companyId) => reply.send({ data: await panelService.listCustomers(companyId) }));

  registerTenantRoute(app, 'PATCH', '/internal/verticals/delivery/customers/:id', ['/internal/panel/customers/:id'],
    async (request, reply, companyId) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as Record<string, unknown>;
      const data = await panelService.updateCustomerNotes(companyId, id, String(body.notes ?? ''));
      return reply.send({ ok: true, data });
    });

  registerTenantRoute(app, 'GET', '/internal/verticals/delivery/customers/:id/orders', ['/internal/panel/customers/:id/orders'],
    async (request, reply, companyId) => {
      const { id } = request.params as { id: string };
      return reply.send({ data: await panelService.customerOrders(companyId, id) });
    });

  registerTenantRoute(app, 'GET', '/internal/verticals/delivery/products', ['/internal/panel/products'],
    async (_request, reply, companyId) => reply.send({ data: await panelService.listProducts(companyId) }));

  registerTenantRoute(app, 'POST', '/internal/verticals/delivery/products', ['/internal/panel/products'],
    async (request, reply, companyId) => {
      const data = await panelService.createProduct(companyId, (request.body ?? {}) as Record<string, unknown>);
      return reply.send({ ok: true, data });
    });

  registerTenantRoute(app, 'PATCH', '/internal/verticals/delivery/products/:id', ['/internal/panel/products/:id'],
    async (request, reply, companyId) => {
      const { id } = request.params as { id: string };
      const data = await panelService.updateProduct(companyId, id, (request.body ?? {}) as Record<string, unknown>);
      return reply.send({ ok: true, data });
    });

  registerTenantRoute(app, 'DELETE', '/internal/verticals/delivery/products/:id', ['/internal/panel/products/:id'],
    async (request, reply, companyId) => {
      const { id } = request.params as { id: string };
      await panelService.deleteProduct(companyId, id);
      return reply.send({ ok: true });
    });

  registerTenantRoute(app, 'POST', '/internal/verticals/delivery/menu/analyze', ['/internal/panel/menu/analyze'],
    async (request, reply, companyId) => {
      const body = (request.body ?? {}) as { images?: unknown[] };
      const jobId = await menuAnalysisService.start(companyId, Array.isArray(body.images) ? body.images as any[] : []);
      return reply.code(202).send({ ok: true, job_id: jobId, status: 'processing' });
    });

  registerTenantRoute(app, 'GET', '/internal/verticals/delivery/menu/analyze/:jobId', ['/internal/panel/menu/analyze/:jobId'],
    async (request, reply, companyId) => {
      const { jobId } = request.params as { jobId: string };
      const job = await menuAnalysisService.get(companyId, jobId);
      if (!job) return reply.code(404).send({ error: 'Análise não encontrada ou expirada.' });
      return reply.send({ ok: true, ...job });
    });

  registerTenantRoute(app, 'POST', '/internal/verticals/delivery/menu/import', ['/internal/panel/menu/import'],
    async (request, reply, companyId) => {
      const body = (request.body ?? {}) as { categories?: unknown[] };
      const data = await panelService.importMenu(companyId, body.categories ?? []);
      return reply.send({ ok: true, ...data });
    });

  registerTenantRoute(app, 'GET', '/internal/verticals/delivery/store', ['/internal/panel/store-info'],
    async (_request, reply, companyId) => reply.send({ data: await panelService.getStoreInfo(companyId) }));

  registerTenantRoute(app, 'PUT', '/internal/verticals/delivery/store', ['/internal/panel/store-info'],
    async (request, reply, companyId) => {
      const data = await panelService.saveStoreInfo(companyId, (request.body ?? {}) as Record<string, unknown>);
      return reply.send({ ok: true, data });
    });

  registerTenantRoute(app, 'GET', '/internal/verticals/delivery/menu/assets', ['/internal/panel/menu-assets'],
    async (_request, reply, companyId) => reply.send({ data: await panelService.listMenuAssets(companyId) }));

  registerTenantRoute(app, 'POST', '/internal/verticals/delivery/menu/assets', ['/internal/panel/menu-assets'],
    async (request, reply, companyId) => {
      const body = (request.body ?? {}) as { pages?: unknown[]; images?: unknown[] };
      const pages = Array.isArray(body.pages) ? body.pages : Array.isArray(body.images) ? body.images : [];
      const data = await panelService.replaceMenuAssets(companyId, pages as Array<string | Record<string, unknown>>);
      return reply.send({ ok: true, data });
    });

  registerTenantRoute(app, 'GET', '/internal/verticals/delivery/reviews', [],
    async (_request, reply, companyId) => {
      const result = await db.query(
        `select id::text,order_id::text,customer_name,phone_number,rating,comment,created_at
         from delivery_reviews where company_id=$1 order by created_at desc`,
        [companyId]
      );
      return reply.send({ data: result.rows });
    });

  // Eventos server-to-server preservam os aliases antigos. A chave interna é
  // obrigatória e cada operação continua limitada por company_id + resource id.
  const orderStatusHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isInternalRequest(request)) return reply.code(401).send({ error: 'unauthorized' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const companyId = suppliedCompanyId(request);
    const orderId = String(body.order_id ?? body.orderId ?? '').trim();
    const status = String(body.status ?? '').trim();
    if (!companyId || !orderId || !status) return reply.code(400).send({ error: 'company_id, order_id e status são obrigatórios' });
    try {
      return reply.send({ ok: true, ...(await deliveryPostSaleService.updateAndNotify({ companyId, orderId, status })) });
    } catch (error) {
      return fail(reply, error);
    }
  };
  app.post('/internal/verticals/delivery/events/order-status', orderStatusHandler);
  app.post('/events/order-status', orderStatusHandler);
  app.post('/webhooks/arles-delivery-events', orderStatusHandler);

  const paymentStatusHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isInternalRequest(request)) return reply.code(401).send({ error: 'unauthorized' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const companyId = suppliedCompanyId(request);
    const orderId = String(body.order_id ?? body.orderId ?? '').trim();
    const paymentStatus = String(body.payment_status ?? body.paymentStatus ?? '').trim().toLowerCase();
    if (!companyId || !orderId || !['pending','pending_approval','approved','rejected'].includes(paymentStatus)) {
      return reply.code(400).send({ error: 'company_id, order_id e payment_status válido são obrigatórios' });
    }
    const updated = await updatePaymentStatus({ companyId, orderId, paymentStatus: paymentStatus as any });
    return updated
      ? reply.send({ ok: true, payment_status: paymentStatus })
      : reply.code(404).send({ error: 'order_not_found' });
  };
  app.post('/internal/verticals/delivery/events/payment-status', paymentStatusHandler);
  app.post('/events/payment-status', paymentStatusHandler);

  // Bridges de migração preservados, fora do fluxo normal do painel.
  app.post('/internal/panel/bootstrap', async (request, reply) => {
    if (!isInternalRequest(request)) return reply.code(401).send({ error: 'unauthorized' });
    const body = (request.body ?? {}) as any;
    try {
      const result = await panelService.bootstrapCompany({
        id: String(body.id ?? body.company_id ?? ''),
        name: String(body.name ?? 'Delivery'),
        subscriptionStatus: body.subscription_status ?? body.subscriptionStatus ?? 'trial',
        trialStartedAt: body.trial_started_at ?? body.trialStartedAt ?? null,
        trialEndsAt: body.trial_ends_at ?? body.trialEndsAt ?? null,
        instagram: body.instagram ?? null,
        storeInfoCompleted: body.store_info_completed === true,
        whatsappCompleted: body.whatsapp_completed === true,
        onboardingCompleted: body.onboarding_completed === true,
        logoUrl: body.logo_url ?? body.logoUrl ?? null
      });
      return reply.send({ ok: true, ...result });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/internal/panel/migrate-legacy', async (request, reply) => {
    if (!isInternalRequest(request)) return reply.code(401).send({ error: 'unauthorized' });
    const companyId = suppliedCompanyId(request);
    if (!companyId) return reply.code(400).send({ error: 'company_id obrigatório' });
    try {
      return reply.send({ ok: true, data: await panelService.migrateLegacyData(companyId, (request.body ?? {}) as any) });
    } catch (error) {
      return fail(reply, error);
    }
  });
}
