import { createHash } from 'node:crypto';
import { redis } from '../infrastructure/redis.js';

function clean(value: unknown): string {
  return String(value ?? '').trim();
}

export function evolutionReplayId(payload: any): string | null {
  const body = payload?.body ?? payload ?? {};
  const event = clean(body.event ?? body.type ?? body.eventType).toUpperCase();
  const data = body.data ?? body;
  const messageId = clean(
    data?.key?.id ??
    data?.message?.key?.id ??
    data?.id ??
    body?.messageId
  );
  if (!messageId || !/MESSAGE/.test(event)) return null;
  const instance = clean(body.instance_name ?? body.instance ?? data?.instance);
  return createHash('sha256')
    .update(`${instance}:${event}:${messageId}`, 'utf8')
    .digest('hex');
}

export async function claimWebhookReplayKey(
  provider: string,
  replayId: string,
  ttlSeconds = 24 * 60 * 60
): Promise<boolean> {
  const key = `arles:webhook:replay:${provider}:${replayId}`;
  const result = await redis.set(key, '1', 'EX', Math.max(60, ttlSeconds), 'NX');
  return result === 'OK';
}
