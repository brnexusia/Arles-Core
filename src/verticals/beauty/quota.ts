import { db } from '../../infrastructure/db.js';
import { redis } from '../../infrastructure/redis.js';

const MAX_SERVICES = Number(process.env.BEAUTY_MAX_SERVICES || 150);
const MAX_PROFESSIONALS = Number(process.env.BEAUTY_MAX_PROFESSIONALS || 75);
const MAX_BOOKINGS_PER_DAY = Number(process.env.BEAUTY_MAX_BOOKINGS_PER_DAY || 1000);

export async function assertServiceCapacity(companyId: string): Promise<void> {
  const result = await db.query<{ count: number }>(
    `select count(*)::int count from beauty_services where company_id=$1`,
    [companyId]
  );
  if (Number(result.rows[0]?.count || 0) >= MAX_SERVICES) throw new Error('BEAUTY_SERVICE_QUOTA_REACHED');
}

export async function assertProfessionalCapacity(companyId: string): Promise<void> {
  const result = await db.query<{ count: number }>(
    `select count(*)::int count from beauty_professionals where company_id=$1`,
    [companyId]
  );
  if (Number(result.rows[0]?.count || 0) >= MAX_PROFESSIONALS) throw new Error('BEAUTY_PROFESSIONAL_QUOTA_REACHED');
}

export async function reserveBookingQuota(companyId: string): Promise<() => Promise<void>> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `arles:beauty:booking-quota:${companyId}:${day}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 172800);
  if (count > MAX_BOOKINGS_PER_DAY) {
    await redis.decr(key).catch(() => undefined);
    throw new Error('BEAUTY_BOOKING_QUOTA_REACHED');
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await redis.decr(key).catch(() => undefined);
  };
}
