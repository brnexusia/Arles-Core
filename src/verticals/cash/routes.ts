import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveTenantContext, tenantErrorStatus } from '../../platform/security/tenant-context.js';
import { cashReports } from './reports.js';
import { cashService } from './service.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function fail(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const tenant = tenantErrorStatus(error);
  const status = tenant !== 500
    ? tenant
    : /NOT_FOUND/.test(message)
      ? 404
      : /INVALID|required/i.test(message)
        ? 400
        : 500;
  return reply.code(status).send({ error: message });
}

function route(
  app: FastifyInstance,
  method: Method,
  url: string,
  handler: (request: FastifyRequest, reply: FastifyReply, companyId: string) => Promise<unknown>
) {
  app.route({
    method,
    url,
    handler: async (request, reply) => {
      try {
        const tenant = await resolveTenantContext(request);
        return await handler(request, reply, tenant.companyId);
      } catch (error) {
        return fail(reply, error);
      }
    }
  });
}

export async function registerCashRoutes(app: FastifyInstance) {
  route(app, 'GET', '/internal/verticals/cash/overview',
    async (_request, reply, companyId) => reply.send({ data: await cashService.overview(companyId) }));

  route(app, 'GET', '/internal/verticals/cash/transactions',
    async (request, reply, companyId) => reply.send({
      data: await cashService.listTransactions(companyId, (request.query ?? {}) as Record<string, unknown>)
    }));

  route(app, 'POST', '/internal/verticals/cash/transactions', async (request, reply, companyId) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const data = await cashService.createTransaction({
      companyId,
      transaction: {
        type: body.type === 'income' ? 'income' : 'expense',
        amount: Number(body.amount),
        category: String(body.category ?? 'Outros'),
        merchant: String(body.merchant ?? ''),
        description: String(body.description ?? ''),
        transactionDate: String(body.transaction_date ?? new Date().toISOString().slice(0, 10))
      }
    });
    await cashReports.ensureScheduled(companyId);
    return reply.code(201).send({ data });
  });

  route(app, 'PATCH', '/internal/verticals/cash/transactions/:id',
    async (request, reply, companyId) => reply.send({
      data: await cashService.updateTransaction(
        companyId,
        String((request.params as { id: string }).id),
        (request.body ?? {}) as Record<string, unknown>
      )
    }));

  route(app, 'DELETE', '/internal/verticals/cash/transactions/:id', async (request, reply, companyId) => {
    await cashService.deleteTransaction(companyId, String((request.params as { id: string }).id));
    return reply.send({ ok: true });
  });

  route(app, 'GET', '/internal/verticals/cash/settings',
    async (_request, reply, companyId) => reply.send({ data: await cashService.settings(companyId) }));

  route(app, 'PUT', '/internal/verticals/cash/settings', async (request, reply, companyId) => {
    const data = await cashService.saveSettings(
      companyId,
      (request.body ?? {}) as Record<string, unknown>
    );
    await cashReports.ensureScheduled(companyId);
    return reply.send({ data });
  });
}

