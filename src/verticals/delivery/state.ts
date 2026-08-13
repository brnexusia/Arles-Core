import { redis } from '../../infrastructure/redis.js';
import { deliveryConfig } from './config.js';

const key = {
  recentConfirmed: (companyId: string, phone: string) =>
    `arles:delivery:recent-confirmed:${companyId}:${phone}`,
  awaitingReview: (companyId: string, phone: string) =>
    `arles:delivery:awaiting-review:${companyId}:${phone}`,
  statusSent: (companyId: string, orderId: string, status: string) =>
    `arles:delivery:order-status-sent:${companyId}:${orderId}:${status}`,
  followupSent: (companyId: string, phone: string) =>
    `arles:delivery:followup-sent:${companyId}:${phone}`
};

export async function markRecentConfirmedOrder(
  companyId: string,
  phone: string,
  orderId: string
): Promise<void> {
  await redis.set(
    key.recentConfirmed(companyId, phone),
    JSON.stringify({ orderId, createdAt: new Date().toISOString() }),
    'EX',
    deliveryConfig.recentConfirmedTtlSeconds
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

export interface ReviewPending {
  orderId: string;
  customerId: string;
  clientName: string;
  companyName: string;
  companyInstagram: string;
}

export async function setAwaitingReview(
  companyId: string,
  phone: string,
  context: ReviewPending
): Promise<void> {
  await redis.set(
    key.awaitingReview(companyId, phone),
    JSON.stringify(context),
    'EX',
    deliveryConfig.reviewTtlSeconds
  );
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

export async function statusAlreadySent(
  companyId: string,
  orderId: string,
  status: string
): Promise<boolean> {
  return Boolean(await redis.get(key.statusSent(companyId, orderId, status)));
}

export async function markStatusSent(
  companyId: string,
  orderId: string,
  status: string
): Promise<void> {
  await redis.set(key.statusSent(companyId, orderId, status), '1', 'EX', 604_800);
}

export async function followupAlreadySent(companyId: string, phone: string): Promise<boolean> {
  return Boolean(await redis.get(key.followupSent(companyId, phone)));
}

export async function markFollowupSent(companyId: string, phone: string): Promise<void> {
  await redis.set(key.followupSent(companyId, phone), '1', 'EX', 14_400);
}
