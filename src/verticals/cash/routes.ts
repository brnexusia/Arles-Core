import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveTenantContext, tenantErrorStatus } from '../../platform/security/tenant-context.js';
import { evolution } from '../../whatsapp/evolution.client.js';
import { env } from '../../config/env.js';
import { caktoPaymentService, cashPlanLabel, type CaktoPaymentResult } from './cakto-payment.js';
import { resolveCashPaymentAlias } from './checkout.js';
import { cashReports } from './reports.js';
import { cashService } from './service.js';
import { formatBrazilDate, isoBrazil } from './time.js';

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
  const cents = Number(nested(body, [
    'amount_cents', 'data.amount_cents', 'data.amountCents', 'purchase.price.value_cents'
  ]));
  if (Number.isInteger(cents) && cents >= 0) return cents;

  const amount = Number(nested(body, [
    'amount', 'data.amount', 'price', 'data.price', 'purchase.price.value'
  ]));
  if (Number.isFinite(amount) && amount >= 0) return Math.round(amount * 100);
  return null;
}

function webhookSecret(request: FastifyRequest, body: Record<string, any>): string[] {
  return [
    String(body.secret ?? '').trim(),
    String(nested(body, ['data.secret', 'fields.secret']) ?? '').trim(),
    String(request.headers['x-cash-webhook-secret'] ?? '').trim(),
    String(request.headers['x-webhook-secret'] ?? '').trim(),
    String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
  ].filter(Boolean);
}

function publicPaymentResult(result: CaktoPaymentResult) {
  return {
    ignored: result.ignored === true,
    duplicate: result.duplicate === true,
    companyId: result.companyId,
    planKey: result.planKey,
    activated: result.activated === true,
    revoked: result.revoked === true,
    canceledAtPeriodEnd: result.canceledAtPeriodEnd === true,
    renewalRefused: result.renewalRefused === true
  };
}

function paymentNotification(result: CaktoPaymentResult): string | null {
  if (result.activated && result.planKey && result.periodEnd) {
    return [
      '✅ Pagamento confirmado!',
      'Seu Arles Cash já está ativo.',
      `📌 Plano: ${cashPlanLabel(result.planKey)}`,
      `📅 Acesso até ${formatBrazilDate(result.periodEnd)}.`,
      '',
      'Pode continuar usando normalmente por aqui. 💰'
    ].join('\n');
  }

  if (result.revoked) {
    return [
      '⚠️ O pagamento do Arles Cash foi estornado ou recebeu chargeback.',
      'Por segurança, o acesso pago foi pausado.',
      'Seu histórico financeiro continua salvo.'
    ].join('\n');
  }

  if (result.canceledAtPeriodEnd) {
    return [
      '✅ Cancelamento da assinatura recebido.',
      result.periodEnd ? `Seu acesso continua disponível até ${formatBrazilDate(result.periodEnd)}.` : 'Seu acesso continua até o fim do período já pago.',
      'Seu histórico continuará salvo.'
    ].join('\n');
  }

  if (result.renewalRefused) {
    return [
      '⚠️ A Cakto informou que a renovação não foi confirmada.',
      result.periodEnd ? `Você ainda pode usar o Arles Cash até ${formatBrazilDate(result.periodEnd)}.` : 'Seu acesso atual será mantido até o fim do período já pago.',
      'Se precisar, mande “planos” para gerar um novo checkout.'
    ].join('\n');
  }

  return null;
}

async function caktoWebhook(request: FastifyRequest, reply: FastifyReply) {
  try {
    if (!env.cashPaymentWebhookSecret) {
      return reply.code(503).send({ error: 'CASH_PAYMENT_WEBHOOK_NOT_CONFIGURED' });
    }

    const body = (request.body ?? {}) as Record<string, any>;
    const secrets = webhookSecret(request, body);
    if (!secrets.includes(env.cashPaymentWebhookSecret)) {
      return reply.code(401).send({ error: 'CASH_PAYMENT_WEBHOOK_UNAUTHORIZED' });
    }

    const eventType = String(nested(body, ['event', 'event_type', 'type', 'data.event']) ?? '').trim();
    const orderId = String(nested(body, [
      'data.id', 'order.id', 'purchase.id', 'purchase.transaction', 'transaction_id', 'id'
    ]) ?? '').trim();
    const amountCents = centsFrom(body);

    const result = await caktoPaymentService.process({
      eventType,
      orderId,
      sck: String(nested(body, [
        'sck', 'data.sck', 'data.tracking.sck', 'data.checkout.sck',
        'data.order.sck', 'data.source.sck', 'tracking.sck'
      ]) ?? ''),
      phone: String(nested(body, [
        'data.customer.phone', 'customer.phone', 'buyer.phone', 'data.buyer.phone',
        'phone', 'customer_phone', 'buyer_phone'
      ]) ?? ''),
      email: String(nested(body, [
        'data.customer.email', 'customer.email', 'buyer.email', 'data.buyer.email',
        'email', 'customer_email', 'buyer_email'
      ]) ?? ''),
      offerId: String(nested(body, ['data.offer.id', 'offer.id', 'offer_id']) ?? ''),
      offerName: String(nested(body, ['data.offer.name', 'offer.name', 'offer_name']) ?? ''),
      productId: String(nested(body, ['data.product.id', 'product.id', 'product_id']) ?? ''),
      productName: String(nested(body, ['data.product.name', 'product.name', 'product_name']) ?? ''),
      subscriptionId: String(nested(body, [
        'data.subscription.id', 'subscription.id', 'subscription_id'
      ]) ?? ''),
      nextPaymentDate: String(nested(body, [
        'data.subscription.next_payment_date', 'data.subscription.nextPaymentDate',
        'subscription.next_payment_date', 'data.next_payment_date'
      ]) ?? ''),
      amountCents,
      payload: body
    });

    // Responde primeiro. A confirmacao no WhatsApp nao deve atrasar o ACK do webhook.
    reply.send({ ok: true, ...publicPaymentResult(result) });

    const notification = paymentNotification(result);
    if (notification && result.ownerPhone && env.cashEvolutionInstance) {
      void evolution.sendText({
        instanceName: env.cashEvolutionInstance,
        to: result.ownerPhone,
        text: notification
      }).catch(error => {
        request.log.error({ err: error, companyId: result.companyId }, 'Falha enviando confirmacao Cakto no WhatsApp');
      });
    }
    return reply;
  } catch (error) {
    return fail(reply, error);
  }
}

export async function registerCashRoutes(app: FastifyInstance) {
  // Link curto enviado no WhatsApp. O token nao expoe e-mail, telefone, company_id
  // nem o endereço da Cakto. Depois do clique, redireciona para o checkout real.
  app.get('/cash/p/:token', async (request, reply) => {
    const token = String((request.params as { token?: string }).token ?? '').trim();
    const target = token ? await resolveCashPaymentAlias(token) : null;
    if (!target) {
      return reply.code(410).type('text/plain; charset=utf-8').send(
        'Este link de pagamento expirou. Volte ao WhatsApp e envie “planos” para gerar um novo link.'
      );
    }
    return reply.redirect(target);
  });

  // Endpoint oficial da Cakto. Mantemos o alias antigo por compatibilidade enquanto
  // a integracao e migrada no painel do provedor.
  app.post('/webhooks/cash/cakto', caktoWebhook);
  app.post('/webhooks/cash/payment', caktoWebhook);

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