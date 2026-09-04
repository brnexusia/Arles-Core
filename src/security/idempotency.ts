import { createHash, randomUUID } from 'node:crypto';
import { redis } from '../infrastructure/redis.js';

function safeKey(value: unknown): string {
  const key = String(value ?? '').trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new Error('IDEMPOTENCY_KEY_INVALID');
  return key;
}

function digest(scope: string, key: string): string {
  return createHash('sha256').update(`${scope}:${key}`, 'utf8').digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withIdempotency<T>(scope: string, keyInput: unknown, fn: () => Promise<T>): Promise<T> {
  const key = safeKey(keyInput);
  const hash = digest(scope, key);
  const resultKey = `arles:idempotency:result:${hash}`;
  const lockKey = `arles:idempotency:lock:${hash}`;

  const cached = await redis.get(resultKey);
  if (cached) return JSON.parse(cached) as T;

  const token = randomUUID();
  const acquired = await redis.set(lockKey, token, 'PX', 30_000, 'NX');
  if (acquired !== 'OK') {
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      const existing = await redis.get(resultKey);
      if (existing) return JSON.parse(existing) as T;
    }
    throw new Error('IDEMPOTENCY_IN_PROGRESS');
  }

  try {
    const secondCheck = await redis.get(resultKey);
    if (secondCheck) return JSON.parse(secondCheck) as T;
    const result = await fn();
    await redis.set(resultKey, JSON.stringify(result), 'EX', 86_400);
    return result;
  } finally {
    await redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
      1,
      lockKey,
      token
    ).catch(() => undefined);
  }
}
