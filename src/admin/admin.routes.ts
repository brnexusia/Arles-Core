import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authService } from '../auth/auth.service.js';
import { isInternalRequest } from '../platform/security/internal-auth.js';
import { adminService } from './admin.service.js';
import { cashOverviewWithOwnerEmail, updateCashUserWithOwnerEmail } from './cash-admin.bridge.js';
import { hasAdminPermission } from './rbac.js';

async function requireAdmin(request: FastifyRequest, reply: FastifyReply, permission: string) {
  if (!isInternalRequest(request)) {
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
  if (!(await hasAdminPermission(user.id, permission))) {
    reply.code(403).send({ error: 'ADMIN_PERMISSION_REQUIRED', permission });
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
    if (!(await requireAdmin(request, reply, 'admin.overview.read'))) return;
    try { return reply.send({ data: await adminService.overview() }); }
    catch (error) {
      request.log.error({ err: error }, 'Falha carregando painel administrativo');
      return reply.code(500).send({ error: 'ADMIN_OVERVIEW_UNAVAILABLE' });
    }
  });

  app.get('/internal/admin/cash/overview', async (request, reply) => {
    if (!(await requireAdmin(request, reply, 'admin.cash.read'))) return;
    try { return reply.send({ data: await cashOverviewWithOwnerEmail() }); }
    catch (error) { return adminError(request, reply, error); }
  });

  app.patch('/internal/admin/cash/users/:companyId', async (request, reply) => {
    if (!(await requireAdmin(request, reply, 'admin.cash.write'))) return;
    try {
      const { companyId } = request.params as { companyId: string };
      const body = (request.body ?? {}) as Record<string, unknown>;
      return reply.send({ data: await updateCashUserWithOwnerEmail(companyId, body) });
    } catch (error) { return adminError(request, reply, error); }
  });

  app.delete('/internal/admin/cash/users/:companyId', async (request, reply) => {
    if (!(await requireAdmin(request, reply, 'admin.cash.delete'))) return;
    try {
      const { companyId } = request.params as { companyId: string };
      return reply.send({ data: await adminService.deleteCashUser(companyId) });
    } catch (error) { return adminError(request, reply, error); }
  });

  app.post('/internal/admin/cash/users/:companyId/expire', async (request, reply) => {
    if (!(await requireAdmin(request, reply, 'admin.cash.write'))) return;
    try {
      const { companyId } = request.params as { companyId: string };
      return reply.send({ data: await adminService.expireCashUser(companyId) });
    } catch (error) { return adminError(request, reply, error); }
  });
}
