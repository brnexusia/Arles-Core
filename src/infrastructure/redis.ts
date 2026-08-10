import Redis from 'ioredis';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

export const redis = new Redis(env.redisUrl, {
  maxRetriesPerRequest: 2,
  enableReadyCheck: true
});

export async function onceMessage(
  companyId: string,
  messageId: string
): Promise<boolean> {
  if (!messageId) return true;
  const key = `arles:dedupe:${companyId}:${messageId}`;
  const result = await redis.set(key, '1', 'EX', 86_400, 'NX');
  return result === 'OK';
}

export async function withConversationLock<T>(
  companyId: string,
  phone: string,
  fn: () => Promise<T>
): Promise<T | null> {
  const key = `arles:lock:${companyId}:${phone}`;
  const token = crypto.randomUUID();

  const acquired = await redis.set(
    key,
    token,
    'PX',
    env.messageLockMs,
    'NX'
  );

  if (acquired !== 'OK') return null;

  try {
    return await fn();
  } finally {
    await redis.eval(
      `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      end
      return 0
      `,
      1,
      key,
      token
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function bufferTextMessage(input: {
  companyId: string;
  phone: string;
  messageId: string;
  text: string;
}): Promise<string | null> {
  if (env.messageBufferMs <= 0) return input.text;

  const key = `arles:buffer:${input.companyId}:${input.phone}`;
  const payload = JSON.stringify({
    id: input.messageId,
    text: input.text
  });

  await redis.rpush(key, payload);
  await redis.expire(key, 10);

  await sleep(env.messageBufferMs);

  const rows = await redis.lrange(key, 0, -1);
  const parsed = rows
    .map(row => {
      try {
        return JSON.parse(row) as { id?: string; text?: string };
      } catch {
        return { id: '', text: row };
      }
    })
    .filter(item => String(item.text ?? '').trim());

  if (!parsed.length) return null;

  const last = parsed[parsed.length - 1];
  if (String(last?.id ?? '') !== input.messageId) return null;

  await redis.del(key);

  return parsed
    .map(item => String(item.text ?? '').trim())
    .filter(Boolean)
    .join('\n');
}

export async function markRecentConfirmedOrder(
  companyId: string,
  phone: string,
  orderId: string
): Promise<void> {
  await redis.set(
    `arles:recent-confirmed:${companyId}:${phone}`,
    JSON.stringify({ orderId, createdAt: new Date().toISOString() }),
    'EX',
    env.recentConfirmedTtlSeconds
  );
}

export async function getRecentConfirmedOrder(
  companyId: string,
  phone: string
): Promise<{ orderId: string; createdAt: string } | null> {
  const raw = await redis.get(`arles:recent-confirmed:${companyId}:${phone}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
