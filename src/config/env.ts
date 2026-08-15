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
  openaiTranscribeModel:
    process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || 'gpt-4o-mini-transcribe',

  evolutionBaseUrl: required('EVOLUTION_BASE_URL').replace(/\/+$/, ''),
  evolutionApiKey: required('EVOLUTION_API_KEY'),
  evolutionSendTextPath:
    process.env.EVOLUTION_SEND_TEXT_PATH?.trim() || '/message/sendText/{instance}',
  evolutionSendMediaPath:
    process.env.EVOLUTION_SEND_MEDIA_PATH?.trim() || '/message/sendMedia/{instance}',
  evolutionMediaBase64Path:
    process.env.EVOLUTION_MEDIA_BASE64_PATH?.trim() || '/chat/getBase64FromMediaMessage/{instance}',

  // Arles Cash usa um único WhatsApp administrado pela Arles.
  // Cada remetente cria/usa a própria conta Cash automaticamente.
  cashEvolutionInstance: process.env.CASH_EVOLUTION_INSTANCE?.trim() ?? '',
  cashOfficialNumber: (process.env.CASH_OFFICIAL_NUMBER?.trim() || '5575999622157').replace(/\D/g, ''),
  cashSignupUrl: process.env.CASH_SIGNUP_URL?.trim() ?? '',
  cashPaymentMonthlyUrl: process.env.CASH_PAYMENT_MONTHLY_URL?.trim() ?? '',
  cashPaymentSemiannualUrl: process.env.CASH_PAYMENT_SEMIANNUAL_URL?.trim() ?? '',
  cashPaymentAnnualUrl: process.env.CASH_PAYMENT_ANNUAL_URL?.trim() ?? '',
  cashPaymentWebhookSecret: process.env.CASH_PAYMENT_WEBHOOK_SECRET?.trim() ?? '',

  publicBaseUrl: (process.env.PUBLIC_BASE_URL?.trim() || '').replace(/\/+$/, ''),
  internalApiKey: process.env.INTERNAL_API_KEY?.trim() ?? '',
  authSessionSecret:
    process.env.AUTH_SESSION_SECRET?.trim() ||
    process.env.INTERNAL_API_KEY?.trim() ||
    '',
  authSessionDays: numberEnv('AUTH_SESSION_DAYS', 30),

  messageBufferMs: numberEnv('MESSAGE_BUFFER_MS', 350),
  messageLockMs: numberEnv('MESSAGE_LOCK_MS', 15000),
  humanPauseSeconds: numberEnv('HUMAN_PAUSE_SECONDS', 3600),
  followupDelaySeconds: numberEnv('FOLLOWUP_DELAY_SECONDS', 1800),
  jobWorkerIntervalMs: numberEnv('JOB_WORKER_INTERVAL_MS', 5000),
  followupWorkerIntervalMs: numberEnv('FOLLOWUP_WORKER_INTERVAL_MS', 15000)
};
