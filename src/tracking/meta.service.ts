import { createHash } from 'node:crypto';
import { db } from '../infrastructure/db.js';

function clean(value: unknown, max = 1200): string {
  return String(value ?? '').trim().slice(0, max);
}
function digits(value: unknown): string { return clean(value, 50).replace(/\D/g, ''); }
function sha(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

async function companyTrackingContext(companyId: string) {
  const result = await db.query<any>(`select
      c.id::text,c.acquisition,c.monthly_price_cents,
      u.email,u.phone
    from companies c
    left join auth_users u on u.company_id=c.id and u.role='user'
    where c.id=$1 and coalesce(c.active_vertical_id,c.vertical)='beauty'
    order by u.created_at asc nulls last limit 1`, [companyId]);
  return result.rows[0] || null;
}

async function sendMetaEvent(input: {
  companyId: string;
  eventName: 'Purchase' | 'Subscribe';
  eventId: string;
  value: number;
  customData?: Record<string, unknown>;
}) {
  const pixelId = clean(process.env.META_PIXEL_ID, 100);
  const token = clean(process.env.META_CAPI_TOKEN, 5000);
  if (!pixelId || !token) return { configured: false };

  const context = await companyTrackingContext(input.companyId);
  if (!context) return { configured: true, skipped: true };
  const acquisition = context.acquisition && typeof context.acquisition === 'object' ? context.acquisition : {};
  const email = clean(context.email, 320).toLowerCase();
  const phone = digits(context.phone);

  const userData: Record<string, unknown> = {
    external_id: [sha(input.companyId)]
  };
  if (email) userData.em = [sha(email)];
  if (phone) userData.ph = [sha(phone)];
  if (clean(acquisition.fbp, 255)) userData.fbp = clean(acquisition.fbp, 255);
  if (clean(acquisition.fbc, 255)) userData.fbc = clean(acquisition.fbc, 255);

  const payload: any = {
    data: [{
      event_name: input.eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: input.eventId,
      event_source_url: clean(acquisition.landing_url, 1500) || 'https://beauty.arlesglobal.com.br/',
      action_source: 'website',
      user_data: userData,
      custom_data: {
        currency: 'BRL',
        value: input.value,
        plan: 'beauty',
        ...input.customData
      }
    }]
  };
  const testCode = clean(process.env.META_TEST_EVENT_CODE, 200);
  if (testCode) payload.test_event_code = testCode;

  const version = clean(process.env.META_GRAPH_VERSION, 20) || 'v26.0';
  const response = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000)
  });
  const text = await response.text().catch(() => '');
  if (!response.ok) throw new Error(`META_CAPI_${response.status}:${text.slice(0, 500)}`);
  return { configured: true, sent: true };
}

export async function trackBeautyAsaasWebhook(companyId: string, payload: any): Promise<void> {
  const eventType = clean(payload?.event, 120);
  const paymentId = clean(payload?.payment?.id || payload?.paymentInstruction?.paymentId || payload?.paymentInstruction?.payment, 200);
  const authorizationId = clean(payload?.authorization?.id || payload?.paymentInstruction?.authorization?.id, 200);

  if (/^PAYMENT_(RECEIVED|CONFIRMED)$/.test(eventType) && paymentId) {
    const value = Number(payload?.payment?.value);
    await sendMetaEvent({
      companyId,
      eventName: 'Purchase',
      eventId: `asaas:${paymentId}:purchase`,
      value: Number.isFinite(value) ? value : 49.9,
      customData: { payment_id: paymentId, billing: 'pix_automatic' }
    });
  }

  if (eventType === 'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED' && authorizationId) {
    await sendMetaEvent({
      companyId,
      eventName: 'Subscribe',
      eventId: `asaas:${authorizationId}:subscribe`,
      value: 49.9,
      customData: { authorization_id: authorizationId, billing: 'pix_automatic' }
    });
  }
}
