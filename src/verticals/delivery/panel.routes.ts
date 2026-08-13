import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import { panelService } from './panel.service.js';
import { menuAnalysisService } from './menu/menu-analysis.service.js';

function authorized(request: FastifyRequest): boolean {
  if (!env.internalApiKey) return false;
  const direct = String(request.headers['x-arles-key'] ?? '').trim();
  const auth = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  return direct === env.internalApiKey || auth === env.internalApiKey;
}

function companyIdFrom(request: FastifyRequest): string {
  const query = (request.query ?? {}) as Record<string, unknown>;
  const body = (request.body ?? {}) as Record<string, unknown>;
  const header = String(request.headers['x-company-id'] ?? '').trim();
  return String(query.company_id ?? body.company_id ?? body.companyId ?? header ?? '').trim();
}

function fail(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : String(error || 'Erro interno');
  const status = /não encontrado/i.test(message) ? 404 : /inválid|obrigat|preço/i.test(message) ? 400 : 500;
  return reply.code(status).send({ error: message });
}

function dualRoutes(app: FastifyInstance) {
  const add = (method: string, path: string, handler: any) => {
    (app as any)[method](path, handler);
    const modularPath = path.replace('/internal/panel', '/internal/verticals/delivery');
    if (modularPath !== path) (app as any)[method](modularPath, handler);
  };

  return {
    get: (path: string, handler: any) => add('get', path, handler),
    post: (path: string, handler: any) => add('post', path, handler),
    put: (path: string, handler: any) => add('put', path, handler),
    patch: (path: string, handler: any) => add('patch', path, handler),
    delete: (path: string, handler: any) => add('delete', path, handler)
  };
}

export async function registerDeliveryPanelRoutes(app: FastifyInstance): Promise<void> {
  const routes = dualRoutes(app);
  routes.post('/internal/panel/bootstrap', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const body = (request.body ?? {}) as any;
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

  routes.post('/internal/panel/migrate-legacy', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const body = (request.body ?? {}) as any;
    const companyId = companyIdFrom(request);
    if (!companyId) return reply.code(400).send({ error: 'company_id obrigatório' });
    try {
      return reply.send({ ok: true, data: await panelService.migrateLegacyData(companyId, body) });
    } catch (error) {
      return fail(reply, error);
    }
  });

  routes.get('/internal/panel/company', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const companyId = companyIdFrom(request);
    if (!companyId) return reply.code(400).send({ error: 'company_id obrigatório' });
    return reply.send({ data: await panelService.companyProgress(companyId) });
  });

  routes.post('/internal/panel/onboarding/complete', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const companyId = companyIdFrom(request);
    if (!companyId) return reply.code(400).send({ error: 'company_id obrigatório' });
    await panelService.setOnboardingComplete(companyId, true);
    return reply.send({ ok: true });
  });

  routes.get('/internal/panel/orders', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const companyId = companyIdFrom(request);
    if (!companyId) return reply.code(400).send({ error: 'company_id obrigatório' });
    return reply.send({ data: await panelService.listOrders(companyId) });
  });

  routes.post('/internal/panel/orders/:id/status', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const companyId = companyIdFrom(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as any;
    try {
      const result = await panelService.updateOrderStatus(companyId, id, String(body.status ?? ''));
      return reply.send({ ok: true, data: result });
    } catch (error) {
      return fail(reply, error);
    }
  });

  routes.post('/internal/panel/orders/:id/payment', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const companyId = companyIdFrom(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as any;
    try {
      const data = await panelService.updateOrderPayment(companyId, id, String(body.payment_status ?? body.status ?? ''));
      return reply.send({ ok: true, data });
    } catch (error) {
      return fail(reply, error);
    }
  });

  routes.get('/internal/panel/customers', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const companyId = companyIdFrom(request);
    return reply.send({ data: await panelService.listCustomers(companyId) });
  });

  routes.patch('/internal/panel/customers/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const companyId = companyIdFrom(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as any;
    try {
      return reply.send({ ok: true, data: await panelService.updateCustomerNotes(companyId, id, String(body.notes ?? '')) });
    } catch (error) {
      return fail(reply, error);
    }
  });

  routes.get('/internal/panel/customers/:id/orders', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const companyId = companyIdFrom(request);
    const { id } = request.params as { id: string };
    return reply.send({ data: await panelService.customerOrders(companyId, id) });
  });

  routes.get('/internal/panel/products', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    return reply.send({ data: await panelService.listProducts(companyIdFrom(request)) });
  });

  routes.post('/internal/panel/products', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const body = (request.body ?? {}) as any;
      const data = await panelService.createProduct(companyIdFrom(request), body);
      return reply.send({ ok: true, data });
    } catch (error) {
      return fail(reply, error);
    }
  });

  routes.patch('/internal/panel/products/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const { id } = request.params as { id: string };
      const data = await panelService.updateProduct(companyIdFrom(request), id, (request.body ?? {}) as any);
      return reply.send({ ok: true, data });
    } catch (error) {
      return fail(reply, error);
    }
  });

  routes.delete('/internal/panel/products/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const companyId = companyIdFrom(request);
    if (!companyId) return reply.code(400).send({ error: 'company_id obrigatório' });
    try {
      const { id } = request.params as { id: string };
      await panelService.deleteProduct(companyId, id);
      return reply.send({ ok: true });
    } catch (error) {
      return fail(reply, error);
    }
  });

  routes.post('/internal/panel/menu/analyze', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const body = (request.body ?? {}) as any;
      const companyId = companyIdFrom(request);
      const images = Array.isArray(body.images) ? body.images : [];
      const jobId = await menuAnalysisService.start(companyId, images);
      return reply.code(202).send({ ok: true, job_id: jobId, status: 'processing' });
    } catch (error) {
      return fail(reply, error);
    }
  });

  routes.get('/internal/panel/menu/analyze/:jobId', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const companyId = companyIdFrom(request);
    const { jobId } = request.params as { jobId: string };
    const job = await menuAnalysisService.get(companyId, jobId);
    if (!job) return reply.code(404).send({ error: 'Análise não encontrada ou expirada.' });
    return reply.send({ ok: true, ...job });
  });

  routes.post('/internal/panel/menu/import', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const body = (request.body ?? {}) as any;
      const data = await panelService.importMenu(companyIdFrom(request), body.categories ?? []);
      return reply.send({ ok: true, ...data });
    } catch (error) {
      return fail(reply, error);
    }
  });

  routes.get('/internal/panel/store-info', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    return reply.send({ data: await panelService.getStoreInfo(companyIdFrom(request)) });
  });

  routes.put('/internal/panel/store-info', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const data = await panelService.saveStoreInfo(companyIdFrom(request), (request.body ?? {}) as any);
      return reply.send({ ok: true, data });
    } catch (error) {
      return fail(reply, error);
    }
  });

  routes.get('/internal/panel/settings', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    return reply.send({ data: await panelService.getSettings(companyIdFrom(request)) });
  });

  routes.put('/internal/panel/settings', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const data = await panelService.saveSettings(companyIdFrom(request), (request.body ?? {}) as any);
    return reply.send({ ok: true, data });
  });

  routes.get('/internal/panel/menu-assets', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    return reply.send({ data: await panelService.listMenuAssets(companyIdFrom(request)) });
  });

  routes.post('/internal/panel/menu-assets', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const body = (request.body ?? {}) as any;
      const pages = Array.isArray(body.pages) ? body.pages : (Array.isArray(body.images) ? body.images : []);
      const data = await panelService.replaceMenuAssets(companyIdFrom(request), pages);
      return reply.send({ ok: true, data });
    } catch (error) {
      return fail(reply, error);
    }
  });

  routes.get('/internal/panel/whatsapp/status', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    return reply.send(await panelService.whatsappStatus(companyIdFrom(request)));
  });

  routes.post('/internal/panel/whatsapp/connect', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      return reply.send(await panelService.whatsappConnect(companyIdFrom(request)));
    } catch (error) {
      return fail(reply, error);
    }
  });

  routes.post('/internal/panel/whatsapp/disconnect', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    return reply.send(await panelService.whatsappDisconnect(companyIdFrom(request)));
  });
}
