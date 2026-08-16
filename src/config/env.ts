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

  // Checkouts Cakto. O Core acrescenta nome, e-mail, telefone e sck da conta
  // dinamicamente antes de redirecionar o cliente para a Cakto.
  cashPaymentMonthlyUrl:
    process.env.CASH_PAYMENT_MONTHLY_URL?.trim() || 'https://pay.cakto.com.br/y2bhspu_1043142',
  cashPaymentQuarterlyUrl:
    process.env.CASH_PAYMENT_QUARTERLY_URL?.trim() || 'https://pay.cakto.com.br/gh5iq23_1043146',
  cashPaymentAnnualUrl:
    process.env.CASH_PAYMENT_ANNUAL_URL?.trim() || 'https://pay.cakto.com.br/uw7bctc_1043148',
  cashPaymentPublicBaseUrl:
    (process.env.CASH_PAYMENT_PUBLIC_BASE_URL?.trim() || '').replace(/\/+$/, ''),
  cashPaymentWebhookSecret: process.env.CASH_PAYMENT_WEBHOOK_SECRET?.trim() ?? '',
  cashCaktoMonthlyOfferId: process.env.CASH_CAKTO_MONTHLY_OFFER_ID?.trim() ?? '',
  cashCaktoQuarterlyOfferId: process.env.CASH_CAKTO_QUARTERLY_OFFER_ID?.trim() ?? '',
  cashCaktoAnnualOfferId: process.env.CASH_CAKTO_ANNUAL_OFFER_ID?.trim() ?? '',

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