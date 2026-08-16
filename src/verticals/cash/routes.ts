import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveTenantContext, tenantErrorStatus } from '../../platform/security/tenant-context.js';
import { evolution } from '../../whatsapp/evolution.client.js';
import { env } from '../../config/env.js';
import { cashActivation, cashPlanLabel } from './activation.js';
import { cashReports } from './reports.js';
import { cashService } from './service.js';
import { isoBrazil } from './time.js';

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

function nested(body: Record<string, any>, paths: string[]): unknown {
  for (const path of paths) {
    let value: any = body;
    let found = true;
    for (const key of path.split('.')) {
      if (value == null || typeof value !== 'object' || !(key in value)) {
        found = false;
        break;
      }
      value = value[key];
    }
    if (found && value != null && String(value).trim() !== '') return value;
  }
  return undefined;
}

function centsFrom(body: Record<string, any>): number | null {
  const cents = Number(nested(body, ['amount_cents', 'data.amount_cents', 'purchase.price.value_cents']));
  if (Number.isInteger(cents) && cents >= 0) return cents;
  const amount = Number(nested(body, ['amount', 'price', 'data.amount', 'purchase.price.value']));
  if (Number.isFinite(amount) && amount >= 0) return Math.round(amount * 100);
  return null;
}

function planFrom(body: Record<string, any>, amountCents: number | null): string {
  const explicit = String(nested(body, [
    'plan_key', 'plan', 'product_name', 'offer_name',
    'product.name', 'data.plan', 'data.product.name', 'purchase.product.name'
  ]) ?? '').trim();
  if (explicit) return explicit;
  if (amountCents === 499) return 'cash_monthly';
  if (amountCents === 2490) return 'cash_semiannual';
  if (amountCents === 3990) return 'cash_annual';
  return '';
}

export async function registerCashRoutes(app: FastifyInstance) {
  // Webhook público para Kirvano/Hotmart (ou um adaptador externo).
  // O pagamento aprovado NÃO libera acesso sozinho: ele gera um código de uso único,
  // vinculado ao WhatsApp da conta, que precisa ser enviado de volta ao Arles Cash.
  app.post('/webhooks/cash/payment', async (request, reply) => {
    try {
      if (!env.cashPaymentWebhookSecret) {
        return reply.code(503).send({ error: 'CASH_PAYMENT_WEBHOOK_NOT_CONFIGURED' });
      }
      const auth = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
      const headerSecret = String(request.headers['x-cash-webhook-secret'] ?? '').trim();
      if (auth !== env.cashPaymentWebhookSecret && headerSecret !== env.cashPaymentWebhookSecret) {
        return reply.code(401).send({ error: 'CASH_PAYMENT_WEBHOOK_UNAUTHORIZED' });
      }

      const body = (request.body ?? {}) as Record<string, any>;
      const query = (request.query ?? {}) as Record<string, unknown>;
      const amountCents = centsFrom(body);
      const result = await cashActivation.registerPayment({
        eventId: String(nested(body, [
          'event_id', 'id', 'webhook_id', 'transaction_id',
          'data.id', 'data.transaction_id', 'purchase.transaction'
        ]) ?? '').trim(),
        provider: String(body.provider ?? query.provider ?? 'external'),
        phone: String(nested(body, [
          'phone', 'customer_phone', 'buyer_phone',
          'customer.phone', 'buyer.phone', 'data.customer.phone', 'data.buyer.phone',
          'purchase.buyer.phone'
        ]) ?? ''),
        email: String(nested(body, [
          'email', 'customer_email', 'buyer_email',
          'customer.email', 'buyer.email', 'data.customer.email', 'data.buyer.email',
          'purchase.buyer.email'
        ]) ?? ''),
        companyId: String(nested(body, ['company_id', 'data.company_id', 'metadata.company_id']) ?? ''),
        plan: planFrom(body, amountCents),
        status: String(nested(body, [
          'status', 'event', 'event_type', 'data.status', 'purchase.status'
        ]) ?? ''),
        amountCents,
        payload: body
      });

      if (
        'activationCode' in result &&
        result.activationCode &&
        result.ownerPhone &&
        env.cashEvolutionInstance
      ) {
        await evolution.sendText({
          instanceName: env.cashEvolutionInstance,
          to: result.ownerPhone,
          text: [
            '✅ Pagamento confirmado!',
            `📌 Plano: ${cashPlanLabel(result.planKey)}`,
            '',
            '🔐 Seu código único de ativação é:',
            `*${result.activationCode}*`,
            '',
            'Envie esse código aqui nesta conversa para ativar seu acesso.',
            '⏳ Ele é válido por 24 horas, funciona uma única vez e somente neste WhatsApp.'
          ].join('\n')
        });
      }

      const publicResult = { ...result } as Record<string, unknown>;
      delete publicResult.activationCode;
      delete publicResult.ownerPhone;
      delete publicResult.ownerEmail;
      return reply.send({ ok: true, ...publicResult });
    } catch (error) {
      return fail(reply, error);
    }
  });

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
        transactionDate: String(body.transaction_date ?? isoBrazil())
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
