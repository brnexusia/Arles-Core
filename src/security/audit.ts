import { db } from '../infrastructure/db.js';

export type AuditEvent = {
  companyId?: string | null;
  actorUserId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  requestId?: string | null;
  source?: string;
  metadata?: Record<string, unknown>;
};

function safeMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  const blocked = /password|secret|token|authorization|cookie|cpf|cnpj|document|message|content|phone|email/i;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !blocked.test(key))
      .slice(0, 20)
      .map(([key, item]) => [key, typeof item === 'string' ? item.slice(0, 200) : item])
  );
}

export async function recordAuditEvent(event: AuditEvent): Promise<void> {
  await db.query(
    `insert into security_audit_events(
       company_id,actor_user_id,action,target_type,target_id,request_id,source,metadata
     ) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      event.companyId || null,
      event.actorUserId || null,
      event.action.slice(0, 120),
      event.targetType?.slice(0, 80) || null,
      event.targetId?.slice(0, 160) || null,
      event.requestId?.slice(0, 160) || null,
      (event.source || 'core').slice(0, 80),
      JSON.stringify(safeMetadata(event.metadata))
    ]
  );
}
