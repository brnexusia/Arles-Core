import { Redis } from 'ioredis';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

export const redis = new Redis(env.redisUrl, {
  maxRetriesPerRequest: 2,
  enableReadyCheck: true
});

const key = {
  dedupe: (companyId: string, messageId: string) => `arles:dedupe:${companyId}:${messageId}`,
  lock: (companyId: string, phone: string) => `arles:lock:${companyId}:${phone}`,
  buffer: (companyId: string, phone: string) => `arles:buffer:${companyId}:${phone}`,
  recentConfirmed: (companyId: string, phone: string) => `arles:recent-confirmed:${companyId}:${phone}`,
  paused: (companyId: string, phone: string) => `arles:paused:${companyId}:${phone}`,
  systemSending: (companyId: string, phone: string) => `arles:system-sending:${companyId}:${phone}`,
  lastInbound: (companyId: string, phone: string) => `arles:last-inbound:${companyId}:${phone}`,
  followupSent: (companyId: string, phone: string) => `arles:followup-sent:${companyId}:${phone}`,
  followupJob: (companyId: string, phone: string) => `arles:followup-job:${companyId}:${phone}`,
  awaitingReview: (companyId: string, phone: string) => `arles:awaiting-review:${companyId}:${phone}`,
  statusSent: (orderId: string, status: string) => `arles:order-status-sent:${orderId}:${status}`,
};

const FOLLOWUP_ZSET = 'arles:followups:due';

export async function onceMessage(companyId: string, messageId: string): Promise<boolean> {
  if (!messageId) return true;
  const result = await redis.set(key.dedupe(companyId, messageId), '1', 'EX', 86_400, 'NX');
  return result === 'OK';
}

export async function withConversationLock<T>(
  companyId: string,
  phone: string,
  fn: () => Promise<T>
): Promise<T | null> {
  const lockKey = key.lock(companyId, phone);
  const token = crypto.randomUUID();
  const acquired = await redis.set(lockKey, token, 'PX', env.messageLockMs, 'NX');
  if (acquired !== 'OK') return null;

  try {
    return await fn();
  } finally {
    await redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`,
      1,
      lockKey,
      token
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type BufferedTextMessage = { id: string; text: string };

export async function bufferTextMessage(input: {
  companyId: string;
  phone: string;
  messageId: string;
  text: string;
}): Promise<string | null> {
  if (env.messageBufferMs <= 0) return input.text;

  const bufferKey = key.buffer(input.companyId, input.phone);
  const payload: BufferedTextMessage = { id: input.messageId, text: input.text };

  await redis.rpush(bufferKey, JSON.stringify(payload));
  await redis.expire(bufferKey, 10);
  await sleep(env.messageBufferMs);

  const rows: string[] = await redis.lrange(bufferKey, 0, -1);
  const parsed: BufferedTextMessage[] = rows
    .map((row: string): BufferedTextMessage => {
      try {
        const value = JSON.parse(row) as Partial<BufferedTextMessage>;
        return { id: String(value.id ?? ''), text: String(value.text ?? '') };
      } catch {
        return { id: '', text: row };
      }
    })
    .filter(item => item.text.trim().length > 0);

  if (!parsed.length) return null;
  const last = parsed[parsed.length - 1];
  if (!last || last.id !== input.messageId) return null;

  await redis.del(bufferKey);
  return parsed.map(item => item.text.trim()).filter(Boolean).join('\n');
}

export async function markRecentConfirmedOrder(companyId: string, phone: string, orderId: string): Promise<void> {
  await redis.set(
    key.recentConfirmed(companyId, phone),
    JSON.stringify({ orderId, createdAt: new Date().toISOString() }),
    'EX',
    env.recentConfirmedTtlSeconds
  );
}

export async function getRecentConfirmedOrder(
  companyId: string,
  phone: string
): Promise<{ orderId: string; createdAt: string } | null> {
  const raw = await redis.get(key.recentConfirmed(companyId, phone));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { orderId: string; createdAt: string };
  } catch {
    return null;
  }
}

export async function pauseConversation(companyId: string, phone: string, seconds = env.humanPauseSeconds): Promise<void> {
  await redis.set(key.paused(companyId, phone), '1', 'EX', seconds);
}

export async function resumeConversation(companyId: string, phone: string): Promise<void> {
  await redis.del(key.paused(companyId, phone));
}

export async function isConversationPaused(companyId: string, phone: string): Promise<boolean> {
  return Boolean(await redis.get(key.paused(companyId, phone)));
}

export async function markSystemSending(companyId: string, phone: string): Promise<void> {
  const sendKey = key.systemSending(companyId, phone);
  await redis.incr(sendKey);
  await redis.expire(sendKey, 20);
}

export async function consumeSystemSending(companyId: string, phone: string): Promise<boolean> {
  const sendKey = key.systemSending(companyId, phone);
  const raw = await redis.get(sendKey);
  const count = Number(raw || 0);

  if (!Number.isFinite(count) || count <= 0) return false;

  if (count <= 1) {
    await redis.del(sendKey);
  } else {
    await redis.decr(sendKey);
  }

  return true;
}

export async function setLastInbound(companyId: string, phone: string, messageId: string): Promise<void> {
  await redis.set(key.lastInbound(companyId, phone), messageId, 'EX', 86_400);
}

export async function getLastInbound(companyId: string, phone: string): Promise<string> {
  return (await redis.get(key.lastInbound(companyId, phone))) ?? '';
}

export interface FollowupJob {
  companyId: string;
  phone: string;
  instanceName: string;
  replyJid: string;
  sourceMessageId: string;
  text: string;
}

export async function scheduleFollowup(job: FollowupJob, delaySeconds = env.followupDelaySeconds): Promise<void> {
  const id = `${job.companyId}:${job.phone}`;
  await redis.set(key.followupJob(job.companyId, job.phone), JSON.stringify(job), 'EX', Math.max(delaySeconds + 14_400, 18_000));
  await redis.zadd(FOLLOWUP_ZSET, Date.now() + delaySeconds * 1000, id);
}

export async function popDueFollowups(limit = 50): Promise<FollowupJob[]> {
  const ids = await redis.zrangebyscore(FOLLOWUP_ZSET, 0, Date.now(), 'LIMIT', 0, limit);
  const jobs: FollowupJob[] = [];

  for (const id of ids) {
    const removed = await redis.zrem(FOLLOWUP_ZSET, id);
    if (!removed) continue;
    const [companyId, ...phoneParts] = id.split(':');
    const phone = phoneParts.join(':');
    if (!companyId || !phone) continue;
    const jobKey = key.followupJob(companyId, phone);
    const raw = await redis.get(jobKey);
    if (!raw) continue;
    await redis.del(jobKey);
    try {
      jobs.push(JSON.parse(raw) as FollowupJob);
    } catch {
      // ignora job corrompido
    }
  }

  return jobs;
}

export async function followupAlreadySent(companyId: string, phone: string): Promise<boolean> {
  return Boolean(await redis.get(key.followupSent(companyId, phone)));
}

export async function markFollowupSent(companyId: string, phone: string): Promise<void> {
  await redis.set(key.followupSent(companyId, phone), '1', 'EX', 14_400);
}

export interface ReviewPending {
  orderId: string;
  customerId: string;
  clientName: string;
  companyName: string;
  companyInstagram: string;
}

export async function setAwaitingReview(companyId: string, phone: string, ctx: ReviewPending): Promise<void> {
  await redis.set(key.awaitingReview(companyId, phone), JSON.stringify(ctx), 'EX', env.reviewTtlSeconds);
}

export async function getAwaitingReview(companyId: string, phone: string): Promise<ReviewPending | null> {
  const raw = await redis.get(key.awaitingReview(companyId, phone));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReviewPending;
  } catch {
    return null;
  }
}

export async function clearAwaitingReview(companyId: string, phone: string): Promise<void> {
  await redis.del(key.awaitingReview(companyId, phone));
}

export async function statusAlreadySent(orderId: string, status: string): Promise<boolean> {
  return Boolean(await redis.get(key.statusSent(orderId, status)));
}

export async function markStatusSent(orderId: string, status: string): Promise<void> {
  await redis.set(key.statusSent(orderId, status), '1', 'EX', 604_800);
}
