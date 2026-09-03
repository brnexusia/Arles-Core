import { randomUUID } from 'node:crypto';
import { redis } from '../infrastructure/redis.js';
import { raiseSecurityAlert } from './alerts.js';
import { enforceRateLimit } from './rate-limit.js';

const CONCURRENCY_LIMIT = 8;
const CONCURRENCY_TTL_MS = 45_000;
const FAILURE_THRESHOLD = 8;
const FAILURE_WINDOW_SECONDS = 5 * 60;
const CIRCUIT_OPEN_SECONDS = 2 * 60;

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function reserveBeautyAiBudget(companyId: string, phone: string): Promise<() => Promise<void>> {
  if (await redis.get(`arles:beauty:ai:circuit:${companyId}`)) throw new Error('BEAUTY_AI_CIRCUIT_OPEN');

  await enforceRateLimit({ scope: 'beauty:ai:phone:hour', limit: 60, windowSeconds: 3600, identity: `${companyId}:${phone}` });
  await enforceRateLimit({ scope: 'beauty:ai:company:hour', limit: 600, windowSeconds: 3600, identity: companyId });
  await enforceRateLimit({ scope: `beauty:ai:company:day:${dayKey()}`, limit: 3000, windowSeconds: 26 * 3600, identity: companyId });

  const key = `arles:beauty:ai:concurrency:${companyId}`;
  const token = randomUUID();
  const now = Date.now();
  const raw = await redis.eval(
    `
      redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
      local count = redis.call('ZCARD', KEYS[1])
      if count >= tonumber(ARGV[2]) then return 0 end
      redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
      redis.call('PEXPIRE', KEYS[1], ARGV[5])
      return 1
    `,
    1,
    key,
    String(now),
    String(CONCURRENCY_LIMIT),
    String(now + CONCURRENCY_TTL_MS),
    token,
    String(CONCURRENCY_TTL_MS + 5000)
  );

  if (Number(raw) !== 1) throw new Error('BEAUTY_AI_BUSY');
  return async () => { await redis.zrem(key, token).catch(() => undefined); };
}

export async function recordBeautyAiSuccess(companyId: string): Promise<void> {
  await redis.del(`arles:beauty:ai:failures:${companyId}`).catch(() => undefined);
}

export async function recordBeautyAiFailure(companyId: string): Promise<void> {
  const failureKey = `arles:beauty:ai:failures:${companyId}`;
  const count = await redis.incr(failureKey);
  if (count === 1) await redis.expire(failureKey, FAILURE_WINDOW_SECONDS);
  if (count >= FAILURE_THRESHOLD) {
    await redis.set(`arles:beauty:ai:circuit:${companyId}`, '1', 'EX', CIRCUIT_OPEN_SECONDS);
    if(count===FAILURE_THRESHOLD){
      void raiseSecurityAlert({
        companyId,
        kind:'beauty_ai_circuit_open',
        severity:'critical',
        fingerprint:`beauty-ai-circuit:${companyId}`,
        metadata:{failures:count,window_seconds:FAILURE_WINDOW_SECONDS,circuit_seconds:CIRCUIT_OPEN_SECONDS}
      }).catch(()=>undefined);
    }
  }
}
