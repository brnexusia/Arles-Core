export function assertTenantScope(sessionCompanyId: string, supplied: string): string {
  const trusted = String(sessionCompanyId).trim();
  if (!trusted || trusted === 'admin') throw new Error('TENANT_REQUIRED');
  if (supplied && supplied !== trusted) throw new Error('TENANT_MISMATCH');
  return trusted;
}
