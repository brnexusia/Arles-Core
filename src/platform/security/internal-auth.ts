import type { FastifyRequest } from 'fastify';
import { internalSecrets, matchesAnySecret } from '../../security/secrets.js';

export function isInternalRequest(request: FastifyRequest): boolean {
  const direct = String(request.headers['x-arles-key'] ?? '').trim();
  const bearer = String(request.headers.authorization ?? '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  const secrets = internalSecrets();
  return matchesAnySecret(direct, secrets) || matchesAnySecret(bearer, secrets);
}
