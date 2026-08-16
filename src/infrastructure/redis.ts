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
  bufferLatest: (companyId: string, phone: string) => `arles:buffer-latest:${companyId}:${phone}`,
  paused: (companyId: string, phone: string) => `arles:paused:${companyId}:${phone}`,
  systemSending: (companyId: string, phone: string) => `arles:system-sending:${companyId}:${phone}`,
  lastInbound: (companyId: string, phone: string) => `arles:last-inbound:${companyId}:${phone}`,
  followupSent: (companyId: string, phone: string) => `arles:followup-sent:${companyId}:${phone}`,
  followupJob: (companyId: string, phone: string) => `arles:followup-job:${companyId}:${phone}`,
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
  waitMs?: number;
}): Promise<string | null> {
  const waitMs = Math.max(0, Number(input.waitMs ?? env.messageBufferMs));
  if (waitMs <= 0) return input.text;

  const bufferKey = key.buffer(input.companyId, input.phone);
  const latestKey = key.bufferLatest(input.companyId, input.phone);
  const payload: BufferedTextMessage = { id: input.messageId, text: input.text };
  const payloadJson = JSON.stringify(payload);
  const ttlSeconds = Math.max(10, Math.ceil(waitMs / 1000) + 30);

  // Enfileirar a mensagem e marcar quem é a mais recente precisa ser uma operação
  // atômica. Sem isso, o consumidor anterior pode apagar uma mensagem que acabou
  // de chegar entre um LRANGE e um DEL.
  await redis.eval(
    `
      redis.call('RPUSH', KEYS[1], ARGV[1])
      redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
      redis.call('EXPIRE', KEYS[1], ARGV[3])
      return 1
    `,
    2,
    bufferKey,
    latestKey,
    payloadJson,
    input.messageId,
    String(ttlSeconds)
  );

  await sleep(waitMs);

  // O consumo também é atômico: somente a mensagem que continua sendo a última
  // após a janela de silêncio pode retirar o lote. Se outra chegou, esta execução
  // sai sem tocar no buffer e a nova mensagem reinicia os 15s normalmente.
  const rawRows = await redis.eval(
    `
      if redis.call('GET', KEYS[2]) ~= ARGV[1] then
        return false
      end
      local rows = redis.call('LRANGE', KEYS[1], 0, -1)
      redis.call('DEL', KEYS[1])
      redis.call('DEL', KEYS[2])
      return rows
    `,
    2,
    bufferKey,
    latestKey,
    input.messageId
  );

  if (!Array.isArray(rawRows) || !rawRows.length) return null;

  const parsed: BufferedTextMessage[] = rawRows
    .map((row: unknown): BufferedTextMessage => {
      const raw = String(row ?? '');
      try {
        const value = JSON.parse(raw) as Partial<BufferedTextMessage>;
        return { id: String(value.id ?? ''), text: String(value.text ?? '') };
      } catch {
        return { id: '', text: raw };
      }
    })
    .filter(item => item.text.trim().length > 0);

  if (!parsed.length) return null;
  return parsed.map(item => item.text.trim()).filter(Boolean).join('\n');
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
