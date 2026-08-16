import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authService } from '../auth/auth.service.js';
import { env } from '../config/env.js';
import { adminService } from './admin.service.js';

function internalAuthorized(request: FastifyRequest): boolean {
  if (!env.internalApiKey) return false;
  const direct = String(request.headers['x-arles-key'] ?? '').trim();
  const bearer = String(request.headers.authorization ?? '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  return direct === env.internalApiKey || bearer === env.internalApiKey;
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!internalAuthorized(request)) {
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }

  const token = String(request.headers['x-arles-session'] ?? '').trim();
  const user = token ? await authService.session(token) : null;
  if (!user) {
    reply.code(401).send({ error: 'SESSION_EXPIRED' });
    return false;
  }
  if (user.role !== 'admin') {
    reply.code(403).send({ error: 'ADMIN_REQUIRED' });
    return false;
  }
  return true;
}

function adminError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  const badRequest = new Set([
    'ADMIN_USER_NOT_FOUND',
    'ADMIN_EMAIL_INVALID',
    'ADMIN_EMAIL_IN_USE',
    'ADMIN_PHONE_INVALID',
    'ADMIN_PHONE_IN_USE',
    'ADMIN_STATUS_INVALID',
    'ADMIN_DATE_INVALID'
  ]);

  if (badRequest.has(code)) {
    const status = code.endsWith('_IN_USE') ? 409 : code === 'ADMIN_USER_NOT_FOUND' ? 404 : 400;
    return reply.code(status).send({ error: code });
  }

  request.log.error({ err: error }, 'Falha no admin Cash');
  return reply.code(500).send({ error: 'ADMIN_CASH_UNAVAILABLE' });
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/internal/admin/overview', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;

    try {
      return reply.send({ data: await adminService.overview() });
    } catch (error) {
      request.log.error({ err: error }, 'Falha carregando painel administrativo');
      return reply.code(500).send({ error: 'ADMIN_OVERVIEW_UNAVAILABLE' });
    }
  });

  app.get('/internal/admin/cash/overview', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    try {
      return reply.send({ data: await adminService.cashOverview() });
    } catch (error) {
      return adminError(request, reply, error);
    }
  });

  app.patch('/internal/admin/cash/users/:companyId', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    try {
      const { companyId } = request.params as { companyId: string };
      const body = (request.body ?? {}) as Record<string, unknown>;
      return reply.send({ data: await adminService.updateCashUser(companyId, body) });
    } catch (error) {
      return adminError(request, reply, error);
    }
  });

  app.post('/internal/admin/cash/users/:companyId/expire', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    try {
      const { companyId } = request.params as { companyId: string };
      return reply.send({ data: await adminService.expireCashUser(companyId) });
    } catch (error) {
      return adminError(request, reply, error);
    }
  });
}
