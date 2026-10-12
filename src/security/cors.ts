import type { FastifyInstance } from 'fastify';

const DEFAULT_ORIGINS = [
  'https://beauty.arlesglobal.com.br',
  'https://delivery.arlesglobal.com.br',
  'https://cash.arlesglobal.com.br',
  'https://arles-hq.arlesglobal.com.br',
  'https://arlesglobal.com.br'
];

function configuredOrigins(): Set<string> {
  const custom = String(process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const origins = new Set([...DEFAULT_ORIGINS, ...custom]);
  if (process.env.NODE_ENV !== 'production') {
    origins.add('http://localhost:5173');
    origins.add('http://127.0.0.1:5173');
  }
  return origins;
}

function normalizedOrigin(value: unknown): string {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

export function registerCorsGuard(app: FastifyInstance): void {
  const allowlist = configuredOrigins();

  app.addHook('onRequest', async (request, reply) => {
    const origin = normalizedOrigin(request.headers.origin);
    if (!origin) return;
    if (!allowlist.has(origin)) {
      return reply.code(403).send({ error: 'CORS_ORIGIN_REJECTED' });
    }

    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
    reply.header('access-control-allow-credentials', 'true');
    reply.header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    reply.header(
      'access-control-allow-headers',
      'Content-Type, Authorization, X-Arles-Key, X-Arles-Session, X-Request-Id'
    );
    reply.header('access-control-max-age', '600');

    if (request.method === 'OPTIONS') {
      return reply.code(204).send();
    }
  });
}
