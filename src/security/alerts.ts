import { db } from '../infrastructure/db.js';

export type SecurityAlertInput = {
  companyId?: string | null;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  fingerprint?: string | null;
  metadata?: Record<string, unknown>;
};

function sanitizeMetadata(metadata: Record<string, unknown> | undefined) {
  if (!metadata) return {};
  const blocked=/password|token|secret|cookie|authorization|phone|email|cpf|cnpj|message|content/i;
  return Object.fromEntries(Object.entries(metadata).filter(([key])=>!blocked.test(key)).slice(0,20));
}

export async function raiseSecurityAlert(input: SecurityAlertInput): Promise<void> {
  const fingerprint=String(input.fingerprint||'').slice(0,180)||null;
  if(fingerprint){
    const recent=await db.query(
      `select 1 from security_alerts
       where fingerprint=$1 and created_at > now() - interval '10 minutes'
       limit 1`,
      [fingerprint]
    );
    if(recent.rowCount)return;
  }
  await db.query(
    `insert into security_alerts(company_id,kind,severity,fingerprint,metadata)
     values($1,$2,$3,$4,$5::jsonb)`,
    [input.companyId||null,input.kind.slice(0,100),input.severity,fingerprint,JSON.stringify(sanitizeMetadata(input.metadata))]
  );
}
