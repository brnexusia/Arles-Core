import { Redis } from 'ioredis';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { cashSilenceRemainingMs } from '../whatsapp/cash-timing.js';

export const redis = new Redis(env.redisUrl, {
  maxRetriesPerRequest: 2,
  enableReadyCheck: true
});

const key = {
  dedupe: (companyId: string, messageId: string) => `arles:dedupe:${companyId}:${messageId}`,
  lock: (companyId: string, phone: string) => `arles:lock:${companyId}:${phone}`,
  buffer: (companyId: string, phone: string) => `arles:buffer:${companyId}:${phone}`,
  bufferLatest: (companyId: string, phone: string) => `arles:buffer-latest:${companyId}:${phone}`,
  cashTyping: (phone: string) => `arles:cash-typing:${phone}`,
  cashActivityAt: (phone: string) => `arles:cash-activity-at:${phone}`,
  paused: (companyId: string, phone: string) => `arles:paused:${companyId}:${phone}`,
  systemSending: (companyId: string, phone: string) => `arles:system-sending:${companyId}:${phone}`,
  lastInbound: (companyId: string, phone: string) => `arles:last-inbound:${companyId}:${phone}`,
  followupSent: (companyId: string, phone: string) => `arles:followup-sent:${companyId}:${phone}`,
  followupJob: (companyId: string, phone: string) => `arles:followup-job:${companyId}:${phone}`,
};

const FOLLOWUP_ZSET = 'arles:followups:due';
const CASH_TYPING_TTL_MS = 120_000;
const CASH_ACTIVITY_TTL_SECONDS = 600;
const CASH_TYPING_POLL_MS = 250;

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

function parseBufferedRows(rawRows: unknown[]): BufferedTextMessage[] {
  return rawRows
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
}

async function enqueueBufferedText(input: {
  companyId: string;
  phone: string;
  messageId: string;
  text: string;
  ttlSeconds: number;
}): Promise<{ bufferKey: string; latestKey: string }> {
  const bufferKey = key.buffer(input.companyId, input.phone);
  const latestKey = key.bufferLatest(input.companyId, input.phone);
  const payload: BufferedTextMessage = { id: input.messageId, text: input.text };

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
    JSON.stringify(payload),
    input.messageId,
    String(input.ttlSeconds)
  );

  return { bufferKey, latestKey };
}

export async function bufferTextMessage(input: {
  companyId: string;
  phone: string;
  messageId: string;
  text: string;
  waitMs?: number;
}): Promise<string | null> {
  const waitMs = Math.max(0, Number(input.waitMs ?? env.messageBufferMs));
  if (waitMs <= 0) return input.text;

  const ttlSeconds = Math.max(10, Math.ceil(waitMs / 1000) + 30);
  const { bufferKey, latestKey } = await enqueueBufferedText({ ...input, ttlSeconds });

  await sleep(waitMs);

  // O consumo também é atômico: somente a mensagem que continua sendo a última
  // após a janela de silêncio pode retirar o lote. Se outra chegou, esta execução
  // sai sem tocar no buffer e a nova mensagem reinicia a janela normalmente.
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
  const parsed = parseBufferedRows(rawRows);
  if (!parsed.length) return null;
  return parsed.map(item => item.text.trim()).filter(Boolean).join('\n');
}

export function isCashActiveTypingPresence(presence: string): boolean {
  const value = String(presence ?? '').trim().toLowerCase();
  return value === 'composing' || value === 'recording';
}

export async function setCashTypingPresence(phone: string, presence: string): Promise<void> {
  const normalizedPhone = String(phone ?? '').replace(/\D/g, '');
  if (!normalizedPhone) return;

  const typingKey = key.cashTyping(normalizedPhone);
  const activityKey = key.cashActivityAt(normalizedPhone);
  const activityAt = String(Date.now());

  if (isCashActiveTypingPresence(presence)) {
    // Começar/continuar digitando reinicia a janela inteira. O TTL é apenas uma rede
    // de segurança caso o WhatsApp não envie o evento `paused` depois.
    await redis.eval(
      `
        redis.call('SET', KEYS[1], '1', 'PX', ARGV[1])
        redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
        return 1
      `,
      2,
      typingKey,
      activityKey,
      String(CASH_TYPING_TTL_MS),
      activityAt,
      String(CASH_ACTIVITY_TTL_SECONDS)
    );
    return;
  }

  // Parou de digitar: remove o estado ativo e marca este instante como nova origem
  // da contagem. Portanto a resposta só pode sair após 5s completos a partir daqui.
  await redis.eval(
    `
      redis.call('DEL', KEYS[1])
      redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
      return 1
    `,
    2,
    typingKey,
    activityKey,
    activityAt,
    String(CASH_ACTIVITY_TTL_SECONDS)
  );
}

export async function isCashTyping(phone: string): Promise<boolean> {
  const normalizedPhone = String(phone ?? '').replace(/\D/g, '');
  if (!normalizedPhone) return false;
  return Boolean(await redis.get(key.cashTyping(normalizedPhone)));
}

export async function bufferCashTextMessage(input: {
  companyId: string;
  phone: string;
  messageId: string;
  text: string;
  silenceMs?: number;
}): Promise<string | null> {
  const silenceMs = Math.max(0, Number(input.silenceMs ?? env.cashMessageSilenceMs));
  if (silenceMs <= 0) return input.text;

  // O buffer precisa sobreviver a uma digitação longa. Cada mensagem nova troca o
  // `latestKey`, mantém o lote acumulado e reinicia os 5s para a nova execução.
  const ttlSeconds = Math.max(300, Math.ceil(silenceMs / 1000) + 60);
  const { bufferKey, latestKey } = await enqueueBufferedText({ ...input, ttlSeconds });
  const normalizedPhone = input.phone.replace(/\D/g, '');
  const typingKey = key.cashTyping(normalizedPhone);
  const activityKey = key.cashActivityAt(normalizedPhone);

  // A própria chegada da mensagem é atividade: os 5s começam do zero aqui.
  await redis.set(activityKey, String(Date.now()), 'EX', CASH_ACTIVITY_TTL_SECONDS);

  let observedTyping = false;

  while (true) {
    await sleep(CASH_TYPING_POLL_MS);

    const [latest, typingRaw, activityRaw] = await redis.mget(latestKey, typingKey, activityKey);
    if (latest !== input.messageId) return null;

    const typing = Boolean(typingRaw);
    const now = Date.now();
    let lastActivityAt = Number(activityRaw || 0);

    if (typing) {
      // Enquanto estiver digitando, a janela permanece inteira em 5s; não existe
      // contagem regressiva paralela ao `composing`/`recording`.
      observedTyping = true;
      continue;
    }

    if (observedTyping && lastActivityAt > 0 && now - lastActivityAt >= CASH_TYPING_TTL_MS - CASH_TYPING_POLL_MS) {
      // Fallback: se `paused` se perdeu e o TTL da presença expirou, iniciamos uma
      // nova janela completa de silêncio em vez de responder imediatamente.
      lastActivityAt = now;
      await redis.set(activityKey, String(lastActivityAt), 'EX', CASH_ACTIVITY_TTL_SECONDS);
    }
    observedTyping = false;

    const remainingMs = cashSilenceRemainingMs({
      lastActivityAt,
      now,
      silenceMs,
      typing: false
    });
    if (remainingMs > 0) continue;

    // Consumo atômico: além de conferir se esta ainda é a última mensagem, validamos
    // que ninguém voltou a digitar e que nenhuma atividade ocorreu nos últimos 5s.
    const cutoff = Date.now() - silenceMs;
    const raw = await redis.eval(
      `
        if redis.call('GET', KEYS[2]) ~= ARGV[1] then
          return cjson.encode({ state = 'superseded' })
        end
        if redis.call('EXISTS', KEYS[3]) == 1 then
          return cjson.encode({ state = 'typing' })
        end
        local activity = tonumber(redis.call('GET', KEYS[4]) or '0')
        if activity > tonumber(ARGV[2]) then
          return cjson.encode({ state = 'active' })
        end
        local rows = redis.call('LRANGE', KEYS[1], 0, -1)
        redis.call('DEL', KEYS[1])
        redis.call('DEL', KEYS[2])
        redis.call('DEL', KEYS[4])
        return cjson.encode({ state = 'ready', rows = rows })
      `,
      4,
      bufferKey,
      latestKey,
      typingKey,
      activityKey,
      input.messageId,
      String(cutoff)
    );

    let result: { state?: string; rows?: unknown[] } = {};
    try {
      result = JSON.parse(String(raw ?? '{}')) as { state?: string; rows?: unknown[] };
    } catch {
      result = {};
    }

    if (result.state === 'superseded') return null;
    if (result.state === 'typing' || result.state === 'active') {
      observedTyping = result.state === 'typing';
      continue;
    }
    if (result.state !== 'ready' || !Array.isArray(result.rows)) return null;

    const parsed = parseBufferedRows(result.rows);
    if (!parsed.length) return null;
    return parsed.map(item => item.text.trim()).filter(Boolean).join('\n');
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
