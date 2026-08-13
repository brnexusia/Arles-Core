import Fastify from 'fastify';
import { composeApplication } from './composition.js';
import { env } from './config/env.js';
import { arlesEngine } from './core/engine.js';
import { checkDb } from './infrastructure/db.js';
import { redis, pauseConversation, resumeConversation } from './infrastructure/redis.js';
import { getMediaByToken } from './media/media.repository.js';
import { isInternalRequest } from './platform/security/internal-auth.js';
import { resolveTenantContext, tenantErrorStatus } from './platform/security/tenant-context.js';
import { startPlatformJobWorker, stopPlatformJobWorker } from './platform/jobs/job.worker.js';

const app = Fastify({
  logger: { level: env.logLevel },
  bodyLimit: 32 * 1024 * 1024
});

app.get('/health', async () => {
  await checkDb();
  await redis.ping();
  return { ok: true, service: 'arles-platform', version: '2.0.0' };
});

app.get('/media/:token', async (request, reply) => {
  const { token } = request.params as { token: string };
  if (!/^[0-9a-f-]{36}$/i.test(token)) return reply.code(404).send({ error: 'not_found' });
  const media = await getMediaByToken(token);
  if (!media) return reply.code(404).send({ error: 'not_found' });
  reply.header('content-type', media.mimeType);
  reply.header('cache-control', 'private, max-age=3600');
  return reply.send(media.data);
});

app.post('/webhooks/evolution', async (request, reply) => {
  const payload = request.body;
  reply.code(202).send({ accepted: true });
  void arlesEngine.handleEvolution(payload).catch(error => {
    request.log.error({ err: error }, 'Falha processando webhook Evolution');
  });
});

async function conversationControl(request: any, reply: any, action: 'pause' | 'resume') {
  if (!isInternalRequest(request)) return reply.code(401).send({ error: 'unauthorized' });
  try {
    const context = await resolveTenantContext(request, { allowLegacyInternalTenant: true });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const phone = String(body.phone ?? '').replace(/\D/g, '');
    if (!phone) return reply.code(400).send({ error: 'phone é obrigatório' });
    if (action === 'pause') {
      await pauseConversation(context.companyId, phone, Number(body.seconds) || env.humanPauseSeconds);
    } else {
      await resumeConversation(context.companyId, phone);
    }
    return reply.send({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(tenantErrorStatus(error)).send({ error: message });
  }
}

app.post('/internal/platform/conversations/pause', (request, reply) => conversationControl(request, reply, 'pause'));
app.post('/internal/platform/conversations/resume', (request, reply) => conversationControl(request, reply, 'resume'));
app.post('/internal/conversations/pause', (request, reply) => conversationControl(request, reply, 'pause'));
app.post('/internal/conversations/resume', (request, reply) => conversationControl(request, reply, 'resume'));

await composeApplication(app);
startPlatformJobWorker();

const shutdown = async () => {
  stopPlatformJobWorker();
  await app.close().catch(() => undefined);
  await redis.quit().catch(() => undefined);
  process.exit(0);
};

process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());

await app.listen({ host: '0.0.0.0', port: env.port });
