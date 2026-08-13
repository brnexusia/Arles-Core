import { redis } from '../../infrastructure/redis.js';

const key = {
  recentConfirmed: (companyId: string, phone: string) =>
    `arles:${companyId}:delivery:recent-confirmed:${phone}`,
  awaitingReview: (companyId: string, phone: string) =>
    `arles:${companyId}:delivery:awaiting-review:${phone}`,
  statusSent: (orderId: string, status: string) =>
    `arles:delivery:order-status-sent:${orderId}:${status}`
};

export interface ReviewPending {
  orderId: string;
  customerId: string;
  clientName: string;
  companyName: string;
  companyInstagram: string;
}

export async function markRecentConfirmedOrder(
  companyId: string,
  phone: string,
  orderId: string,
  ttlSeconds: number
): Promise<void> {
  await redis.set(
    key.recentConfirmed(companyId, phone),
    JSON.stringify({ orderId, createdAt: new Date().toISOString() }),
    'EX',
    ttlSeconds
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

export async function setAwaitingReview(
  companyId: string,
  phone: string,
  value: ReviewPending,
  ttlSeconds: number
): Promise<void> {
  await redis.set(key.awaitingReview(companyId, phone), JSON.stringify(value), 'EX', ttlSeconds);
}

export async function getAwaitingReview(
  companyId: string,
  phone: string
): Promise<ReviewPending | null> {
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
