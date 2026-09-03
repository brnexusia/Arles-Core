import Fastify from 'fastify';
import { env } from './config/env.js';
import { checkDb } from './infrastructure/db.js';
import { redis, pauseConversation, resumeConversation, setCashTypingPresence } from './infrastructure/redis.js';
import { arlesEngine } from './core/engine.js';
import { getMediaByToken } from './media/media.repository.js';
import { startFollowupWorker, stopFollowupWorker } from './workers/followup.worker.js';
import { startPlatformJobWorker, stopPlatformJobWorker } from './platform/jobs/job.worker.js';
import { registerAuthRoutes } from './auth/auth.routes.js';
import { registerBillingRoutes } from './billing/billing.routes.js';
import { registerAdminRoutes } from './admin/admin.routes.js';
import { registerPlatformRoutes } from './platform/platform.routes.js';
import { registerBuiltInVerticals } from './verticals/index.js';
import { registerBuiltInPlatformModules } from './composition.js';
import { evolution } from './whatsapp/evolution.client.js';
import { normalizeEvolutionPresence } from './whatsapp/normalize.js';
import { isInternalRequest } from './platform/security/internal-auth.js';
import { registerCorsGuard } from './security/cors.js';
import { safeStoredMediaMime } from './security/media.js';
import { claimWebhookReplayKey, evolutionReplayId } from './security/webhook-replay.js';

const app = Fastify({
  logger: { level: env.logLevel },
  bodyLimit: 2 * 1024 * 1024
});

registerCorsGuard(app);

function evolutionInstanceName(payload: any): string {
  const body = payload?.body ?? payload ?? {};
  return String(body?.instance_name ?? body?.instance ?? body?.data?.instance ?? '').trim();
}

function inferredPublicBaseUrl(request: { headers: Record<string, unknown> }): string {
  const proto = String(request.headers['x-forwarded-proto'] ?? 'https').split(',')[0]?.trim() || 'https';
  const host = String(request.headers['x-forwarded-host'] ?? request.headers.host ?? '').split(',')[0]?.trim() || '';
  return host ? `${proto}://${host}`.replace(/\/+$/, '') : '';
}

let cashPresenceWebhookReady = false;
let cashPresenceWebhookAttempting = false;

async function ensureCashPresenceWebhook(
  request: { headers: Record<string, unknown>; log: { warn: (...args: any[]) => void; info: (...args: any[]) => void } },
  payload: unknown
): Promise<void> {
  if (cashPresenceWebhookReady || cashPresenceWebhookAttempting || !env.cashEvolutionInstance) return;
  if (evolutionInstanceName(payload) !== env.cashEvolutionInstance) return;
  const baseUrl = env.publicBaseUrl || inferredPublicBaseUrl(request);
  if (!baseUrl) return;
  cashPresenceWebhookAttempting = true;
  try {
    await evolution.setWebhook(env.cashEvolutionInstance, `${baseUrl}/webhooks/evolution`);
    cashPresenceWebhookReady = true;
    request.log.info('Webhook do Cash atualizado com PRESENCE_UPDATE.');
  } catch (error) {
    request.log.warn({ err: error }, 'Não foi possível atualizar o webhook de presença do Cash agora.');
  } finally {
    cashPresenceWebhookAttempting = false;
  }
}

app.get('/health', async () => {
  await checkDb();
  await redis.ping();
  return { ok: true, service: 'arles-engine', version: '2.2.1' };
});

app.get('/media/:token', async (request, reply) => {
  const { token } = request.params as { token: string };
  if (!/^[0-9a-f-]{36}$/i.test(token)) return reply.code(404).send({ error: 'not_found' });
  const media = await getMediaByToken(token);
  if (!media) return reply.code(404).send({ error: 'not_found' });
  const mime = safeStoredMediaMime(media.mimeType);
  if (!mime) return reply.code(415).send({ error: 'unsupported_media_type' });
  reply.header('content-type', mime);
  reply.header('x-content-type-options', 'nosniff');
  reply.header('content-disposition', 'inline');
  reply.header('cache-control', 'private, max-age=3600');
  return reply.send(media.data);
});

app.post('/webhooks/evolution', { bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
  const payload = request.body;
  const replayId = evolutionReplayId(payload);
  if (replayId) {
    const claimed = await claimWebhookReplayKey('evolution', replayId);
    if (!claimed) return reply.code(202).send({ accepted: true, duplicate: true });
  }

  reply.code(202).send({ accepted: true });
  const presence = normalizeEvolutionPresence(payload);
  if (presence && env.cashEvolutionInstance && presence.instanceName === env.cashEvolutionInstance) {
    void setCashTypingPresence(presence.phone, presence.presence).catch(error => {
      request.log.error({ err: error }, 'Falha salvando presença de digitação do Cash');
    });
    return;
  }
  void ensureCashPresenceWebhook(request as any, payload);
  void arlesEngine.handleEvolution(payload).catch(error => {
    request.log.error({ err: error }, 'Falha processando webhook Evolution');
  });
});

app.post('/internal/conversations/pause', { bodyLimit: 16 * 1024 }, async (request, reply) => {
  if (!isInternalRequest(request)) return reply.code(401).send({ error: 'unauthorized' });
  const body = (request.body ?? {}) as any;
  const companyId = String(body.company_id ?? '').trim();
  const phone = String(body.phone ?? '').replace(/\D/g, '');
  if (!companyId || !phone) return reply.code(400).send({ error: 'company_id e phone são obrigatórios' });
  await pauseConversation(companyId, phone, Number(body.seconds) || env.humanPauseSeconds);
  return reply.send({ ok: true });
});

app.post('/internal/conversations/resume', { bodyLimit: 16 * 1024 }, async (request, reply) => {
  if (!isInternalRequest(request)) return reply.code(401).send({ error: 'unauthorized' });
  const body = (request.body ?? {}) as any;
  const companyId = String(body.company_id ?? '').trim();
  const phone = String(body.phone ?? '').replace(/\D/g, '');
  if (!companyId || !phone) return reply.code(400).send({ error: 'company_id e phone são obrigatórios' });
  await resumeConversation(companyId, phone);
  return reply.send({ ok: true });
});

registerBuiltInPlatformModules();
await registerAuthRoutes(app);
await registerBillingRoutes(app);
await registerAdminRoutes(app);
await registerPlatformRoutes(app);
await registerBuiltInVerticals(app);

startFollowupWorker();
startPlatformJobWorker();

const shutdown = async () => {
  stopFollowupWorker();
  stopPlatformJobWorker();
  await app.close().catch(() => undefined);
  await redis.quit().catch(() => undefined);
  process.exit(0);
};

process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());

await app.listen({ host: '0.0.0.0', port: env.port });

if (env.cashEvolutionInstance && env.publicBaseUrl) {
  void evolution
    .setWebhook(env.cashEvolutionInstance, `${env.publicBaseUrl}/webhooks/evolution`)
    .then(() => {
      cashPresenceWebhookReady = true;
      app.log.info('Webhook do Cash atualizado com PRESENCE_UPDATE no boot.');
    })
    .catch(error => {
      app.log.warn({ err: error }, 'Não foi possível atualizar o webhook de presença do Cash no boot.');
    });
}
