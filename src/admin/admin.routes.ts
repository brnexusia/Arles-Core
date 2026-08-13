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
}

