import type { FastifyRequest } from 'fastify';
import { authService, type AuthUserView } from '../../auth/auth.service.js';
import { isInternalRequest } from './internal-auth.js';
import { assertTenantScope } from './tenant-scope.js';

export interface TenantContext {
  companyId: string;
  user: AuthUserView | null;
  source: 'session' | 'legacy-internal';
}

export function suppliedCompanyId(request: FastifyRequest): string {
  const query = (request.query ?? {}) as Record<string, unknown>;
  const body = (request.body ?? {}) as Record<string, unknown>;
  return String(
    query.company_id ??
    query.companyId ??
    body.company_id ??
    body.companyId ??
    request.headers['x-company-id'] ??
    ''
  ).trim();
}

export async function resolveTenantContext(
  request: FastifyRequest,
  options: { allowLegacyInternalTenant?: boolean } = {}
): Promise<TenantContext> {
  if (!isInternalRequest(request)) throw new Error('INTERNAL_UNAUTHORIZED');

  const supplied = suppliedCompanyId(request);
  const token = String(request.headers['x-arles-session'] ?? '').trim();

  if (token) {
    const user = await authService.session(token);
    if (!user) throw new Error('SESSION_EXPIRED');
    return {
      companyId: assertTenantScope(user.companyId, supplied),
      user,
      source: 'session'
    };
  }

  // Adaptadores antigos permanecem disponíveis para integrações server-to-server
  // que já possuem a chave interna. Rotas novas nunca habilitam este fallback.
  if (options.allowLegacyInternalTenant && supplied) {
    return { companyId: supplied, user: null, source: 'legacy-internal' };
  }

  throw new Error('SESSION_REQUIRED');
}

export function tenantErrorStatus(error: unknown): number {
  const code = error instanceof Error ? error.message : String(error);
  if (code === 'INTERNAL_UNAUTHORIZED' || code === 'SESSION_EXPIRED' || code === 'SESSION_REQUIRED') return 401;
  if (code === 'TENANT_REQUIRED' || code === 'TENANT_MISMATCH') return 403;
  return 500;
}
