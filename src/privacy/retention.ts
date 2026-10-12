import { db } from '../infrastructure/db.js';

export async function runPrivacyRetention(): Promise<void> {
  // Authentication artifacts: keep only what can still be used operationally.
  await db.query(`delete from auth_sessions where expires_at <= now() or last_seen_at < now() - interval '8 days'`);
  await db.query(`delete from auth_password_reset_tokens where created_at < now() - interval '1 day'`);

  // Security telemetry has finite retention and contains no message bodies by design.
  await db.query(`delete from security_alerts where created_at < now() - interval '180 days'`);
  await db.query(`delete from security_audit_events where created_at < now() - interval '400 days'`);

  // Keep financial identifiers/status/value, but remove raw provider payloads after 90 days.
  await db.query(`update asaas_events set payload='{}'::jsonb where created_at < now() - interval '90 days' and payload <> '{}'::jsonb`);
  await db.query(`update beauty_billing_payments set payload='{}'::jsonb where created_at < now() - interval '90 days' and payload <> '{}'::jsonb`);

  // Beauty conversation data: raw webhook payload is short-lived; text is retained only
  // for support/history and is eventually removed. Other Arles verticals are untouched.
  await db.query(`update messages m set raw_payload=null
    from companies c
    where m.company_id=c.id
      and coalesce(c.active_vertical_id,c.vertical)='beauty'
      and m.created_at < now() - interval '30 days'
      and m.raw_payload is not null`);

  await db.query(`update messages m set body=null
    from companies c
    where m.company_id=c.id
      and coalesce(c.active_vertical_id,c.vertical)='beauty'
      and m.created_at < now() - interval '180 days'
      and m.body is not null`);

  await db.query(`delete from messages m using companies c
    where m.company_id=c.id
      and coalesce(c.active_vertical_id,c.vertical)='beauty'
      and m.created_at < now() - interval '365 days'`);

  await db.query(`delete from conversation_sessions cs using companies c
    where cs.company_id=c.id
      and coalesce(c.active_vertical_id,c.vertical)='beauty'
      and cs.updated_at < now() - interval '90 days'`);
}

let timer: NodeJS.Timeout | null = null;

export function startPrivacyRetentionWorker(): void {
  if (timer) return;
  const run = () => void runPrivacyRetention().catch(error => {
    console.error('[privacy-retention] cleanup failed', error instanceof Error ? error.message : String(error));
  });
  setTimeout(run, 30_000).unref();
  timer = setInterval(run, 24 * 60 * 60 * 1000);
  timer.unref();
}

export function stopPrivacyRetentionWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
