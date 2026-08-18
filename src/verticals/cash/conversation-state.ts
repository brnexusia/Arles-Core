const QUERY_TTL_SECONDS = 30 * 60;
const RECENT_RECORD_TTL_SECONDS = 10 * 60;
const DEFERRED_QUERY_TTL_SECONDS = 15 * 60;

async function redisClient() {
  // Lazy import: classificadores/testes puros não precisam abrir conexão Redis.
  // Em produção, o mesmo singleton de infrastructure/redis continua sendo usado.
  return (await import('../../infrastructure/redis.js')).redis;
}

function phoneKey(phone: string): string {
  return String(phone ?? '').replace(/\D/g, '');
}

function queryKey(companyId: string, phone: string): string {
  return `arles:cash:query:${companyId}:${phoneKey(phone)}`;
}

function recentRecordKey(companyId: string, phone: string): string {
  return `arles:cash:guard:recent-record:${companyId}:${phoneKey(phone)}`;
}

function deferredQueryKey(companyId: string, phone: string): string {
  return `arles:cash:guard:deferred-query:${companyId}:${phoneKey(phone)}`;
}

export async function rememberCashQueryContext(companyId: string, phone: string, query: string): Promise<void> {
  const clean = String(query ?? '').trim();
  if (!clean) return;
  const redis = await redisClient();
  await redis.set(queryKey(companyId, phone), clean.slice(0, 1000), 'EX', QUERY_TTL_SECONDS);
}

export async function getCashQueryContext(companyId: string, phone: string): Promise<string | null> {
  const redis = await redisClient();
  return await redis.get(queryKey(companyId, phone));
}

export async function clearCashQueryContext(companyId: string, phone: string): Promise<void> {
  const redis = await redisClient();
  await redis.del(queryKey(companyId, phone));
}

export async function rememberCashRecentRecordReference(companyId: string, phone: string): Promise<void> {
  const redis = await redisClient();
  await redis.set(recentRecordKey(companyId, phone), '1', 'EX', RECENT_RECORD_TTL_SECONDS);
}

export async function consumeCashRecentRecordReference(companyId: string, phone: string): Promise<boolean> {
  const redis = await redisClient();
  const key = recentRecordKey(companyId, phone);
  const current = await redis.get(key);
  if (!current) return false;
  await redis.del(key);
  return true;
}

export async function clearCashRecentRecordReference(companyId: string, phone: string): Promise<void> {
  const redis = await redisClient();
  await redis.del(recentRecordKey(companyId, phone));
}

export async function rememberCashDeferredQuery(companyId: string, phone: string, query: string): Promise<void> {
  const clean = String(query ?? '').trim();
  if (!clean) return;
  const redis = await redisClient();
  await redis.set(deferredQueryKey(companyId, phone), clean.slice(0, 1000), 'EX', DEFERRED_QUERY_TTL_SECONDS);
}

export async function consumeCashDeferredQuery(companyId: string, phone: string): Promise<string | null> {
  const redis = await redisClient();
  const key = deferredQueryKey(companyId, phone);
  const current = await redis.get(key);
  if (!current) return null;
  await redis.del(key);
  return current;
}

export async function clearCashDeferredQuery(companyId: string, phone: string): Promise<void> {
  const redis = await redisClient();
  await redis.del(deferredQueryKey(companyId, phone));
}
