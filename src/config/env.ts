import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Variável inválida: ${name}`);
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: numberEnv('PORT', 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',

  databaseUrl: required('DATABASE_URL'),
  redisUrl: required('REDIS_URL'),

  openaiApiKey: process.env.OPENAI_API_KEY?.trim() ?? '',
  openaiModel: process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini',

  evolutionBaseUrl: required('EVOLUTION_BASE_URL').replace(/\/+$/, ''),
  evolutionApiKey: required('EVOLUTION_API_KEY'),
  evolutionSendTextPath:
    process.env.EVOLUTION_SEND_TEXT_PATH?.trim() || '/message/sendText/{instance}',

  messageBufferMs: numberEnv('MESSAGE_BUFFER_MS', 350),
  messageLockMs: numberEnv('MESSAGE_LOCK_MS', 15000),
  recentConfirmedTtlSeconds: numberEnv('RECENT_CONFIRMED_TTL_SECONDS', 86400)
};
