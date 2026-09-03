import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { redis } from '../infrastructure/redis.js';

export type RateLimitRule = {
  scope: string;
  limit: number;
  windowSeconds: number;
  identity: string;
};

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}

export function requestIp(request: FastifyRequest): string {
  const forwarded = String(request.headers['x-forwarded-for'] ?? '')
    .split(',')[0]
    ?.trim();
  return (forwarded || request.ip || 'unknown').slice(0, 128);
}

export function rateIdentity(value: unknown): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  return digest(normalized || 'anonymous');
}

export async function enforceRateLimit(
  rule: RateLimitRule,
  reply?: FastifyReply
): Promise<{ remaining: number; resetSeconds: number }> {
  const window = Math.max(1, Math.floor(rule.windowSeconds));
  const limit = Math.max(1, Math.floor(rule.limit));
  const key = `arles:rl:${rule.scope}:${rateIdentity(rule.identity)}`;

  const raw = await redis.eval(
    `
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      local ttl = redis.call('TTL', KEYS[1])
      return {count, ttl}
    `,
    1,
    key,
    String(window)
  );

  const tuple = Array.isArray(raw) ? raw : [];
  const count = Number(tuple[0] ?? 1);
  const ttl = Math.max(1, Number(tuple[1] ?? window));
  const remaining = Math.max(0, limit - count);

  if (reply) {
    reply.header('x-ratelimit-limit', String(limit));
    reply.header('x-ratelimit-remaining', String(remaining));
    reply.header('x-ratelimit-reset', String(ttl));
  }

  if (count > limit) {
    if (reply) reply.header('retry-after', String(ttl));
    const error = new Error('RATE_LIMITED');
    (error as Error & { retryAfter?: number }).retryAfter = ttl;
    throw error;
  }

  return { remaining, resetSeconds: ttl };
}

export async function enforceIpLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  scope: string,
  limit: number,
  windowSeconds: number
): Promise<void> {
  await enforceRateLimit({
    scope,
    limit,
    windowSeconds,
    identity: requestIp(request)
  }, reply);
}
