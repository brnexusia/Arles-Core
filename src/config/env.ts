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

const defaultQuarterlyCheckout = 'https://pay.cakto.com.br/gh5iq23_1043146';

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

  // Beauty is intentionally pinned to the low-cost model. A stale global
  // OPENAI_MODEL cannot silently move this vertical to a more expensive model.
  beautyOpenaiModel: 'gpt-5-nano',

  evolutionBaseUrl: required('EVOLUTION_BASE_URL').replace(/\/+$/, ''),
  evolutionApiKey: required('EVOLUTION_API_KEY'),
  evolutionSendTextPath:
    process.env.EVOLUTION_SEND_TEXT_PATH?.trim() || '/message/sendText/{instance}',
  evolutionSendMediaPath:
    process.env.EVOLUTION_SEND_MEDIA_PATH?.trim() || '/message/sendMedia/{instance}',
  evolutionMediaBase64Path:
    process.env.EVOLUTION_MEDIA_BASE64_PATH?.trim() || '/chat/getBase64FromMediaMessage/{instance}',

  // Optional server-only JSON array used only by Beauty, e.g.
  // [{"key":"evolution-01","baseUrl":"https://...","apiKey":"...","maxInstances":20}]
  // If empty, Beauty keeps using the current Evolution singleton, so existing
  // deployments remain backwards compatible until shards are configured.
  beautyEvolutionClustersJson: process.env.BEAUTY_EVOLUTION_CLUSTERS?.trim() ?? '',

  // Asaas Pix Automático. Optional at process boot so current Arles products are
  // never taken down by a Beauty credential that has not been provisioned yet.
  asaasApiBaseUrl: (process.env.ASAAS_API_BASE_URL?.trim() || 'https://api.asaas.com/v3').replace(/\/+$/, ''),
  asaasApiKey: process.env.ASAAS_API_KEY?.trim() ?? '',
  asaasWebhookToken: process.env.ASAAS_WEBHOOK_TOKEN?.trim() ?? '',
  beautyMonthlyPriceCents: numberEnv('BEAUTY_MONTHLY_PRICE_CENTS', 4990),

  // Arles Cash usa um único WhatsApp administrado pela Arles.
  // Cada remetente cria/usa a própria conta Cash automaticamente.
  cashEvolutionInstance: process.env.CASH_EVOLUTION_INSTANCE?.trim() ?? '',
  cashOfficialNumber: (process.env.CASH_OFFICIAL_NUMBER?.trim() || '5575999622157').replace(/\D/g, ''),
  cashSignupUrl: process.env.CASH_SIGNUP_URL?.trim() ?? '',
  // O Cash fica fixado no GPT-5 nano tanto para intenção/contexto quanto para
  // extrações estruturadas. Assim um env antigo não troca o modelo sem revisão de código.
  cashOpenaiModel: 'gpt-5-nano',
  cashOpenaiSecondModel: 'gpt-5-nano',
  // Janela antiga mantida só por compatibilidade com deploys existentes.
  cashMessageBufferMs: numberEnv('CASH_MESSAGE_BUFFER_MS', 15000),
  // Alvo de baixa latência: após o usuário parar de digitar/gravar, processa quase
  // imediatamente. O teto de 500ms também corrige deploys antigos que ainda tenham 5s.
  cashMessageSilenceMs: Math.min(numberEnv('CASH_MESSAGE_SILENCE_MS', 250), 500),

  // Checkouts Cakto. O Core acrescenta nome, e-mail, telefone e sck da conta
  // dinamicamente antes de redirecionar o cliente para a Cakto.
  cashPaymentMonthlyUrl:
    process.env.CASH_PAYMENT_MONTHLY_URL?.trim() || 'https://pay.cakto.com.br/y2bhspu_1043142',
  cashPaymentQuarterlyUrl:
    process.env.CASH_PAYMENT_QUARTERLY_URL?.trim() || defaultQuarterlyCheckout,
  // Alias legado apenas para manter código antigo compilando durante a migração.
  cashPaymentSemiannualUrl:
    process.env.CASH_PAYMENT_SEMIANNUAL_URL?.trim() ||
    process.env.CASH_PAYMENT_QUARTERLY_URL?.trim() ||
    defaultQuarterlyCheckout,
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
