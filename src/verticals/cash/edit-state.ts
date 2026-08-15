import { redis } from '../../infrastructure/redis.js';

const EDIT_TTL_SECONDS = 10 * 60;

function key(companyId: string, phone: string): string {
  return `arles:cash:edit:${companyId}:${phone.replace(/\D/g, '')}`;
}

export async function setCashEditState(companyId: string, phone: string, transactionId: string): Promise<void> {
  await redis.set(key(companyId, phone), transactionId, 'EX', EDIT_TTL_SECONDS);
}

export async function getCashEditState(companyId: string, phone: string): Promise<string | null> {
  return await redis.get(key(companyId, phone));
}

export async function clearCashEditState(companyId: string, phone: string): Promise<void> {
  await redis.del(key(companyId, phone));
}
