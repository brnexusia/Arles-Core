import type { FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';

export function isInternalRequest(request: FastifyRequest): boolean {
  if (!env.internalApiKey) return false;
  const direct = String(request.headers['x-arles-key'] ?? '').trim();
  const bearer = String(request.headers.authorization ?? '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  return direct === env.internalApiKey || bearer === env.internalApiKey;
}
