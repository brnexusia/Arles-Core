import { describe, expect, it } from 'vitest';
import { assertTenantScope } from '../src/platform/security/tenant-scope.js';

describe('tenant context', () => {
  it('usa a empresa da sessão e ignora ausência de company_id do browser', () => {
    expect(assertTenantScope('tenant-a', '')).toBe('tenant-a');
  });

  it('rejeita tentativa de acessar outro tenant', () => {
    expect(() => assertTenantScope('tenant-a', 'tenant-b')).toThrow('TENANT_MISMATCH');
  });

  it('não aceita admin sem tenant explícito de uma operação privilegiada', () => {
    expect(() => assertTenantScope('admin', '')).toThrow('TENANT_REQUIRED');
  });
});
