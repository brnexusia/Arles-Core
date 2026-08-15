import Fastify from 'fastify';
import { env } from './config/env.js';
import { checkDb } from './infrastructure/db.js';
import { redis, pauseConversation, resumeConversation } from './infrastructure/redis.js';
import { arlesEngine } from './core/engine.js';
import { getMediaByToken } from './media/media.repository.js';
import { startFollowupWorker, stopFollowupWorker } from './workers/followup.worker.js';
import { startPlatformJobWorker, stopPlatformJobWorker } from './platform/jobs/job.worker.js';
import { composeApplication } from './composition.js';

const app = Fastify({
  logger: { level: env.logLevel },
  bodyLimit: 32 * 1024 * 1024
});

function authorized(request: { headers: Record<string, unknown> }): boolean {
  if (!env.internalApiKey) return false;
  const direct = String(request.headers['x-arles-key'] ?? '').trim();
  const auth = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  return direct === env.internalApiKey || auth === env.internalApiKey;
}

app.get('/health', async () => {
  await checkDb();
  await redis.ping();
  return { ok: true, service: 'arles-engine', version: '2.2.0' };
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

app.post('/internal/conversations/pause', async (request, reply) => {
  if (!authorized(request as any)) return reply.code(401).send({ error: 'unauthorized' });
  const body = (request.body ?? {}) as any;
  const companyId = String(body.company_id ?? '').trim();
  const phone = String(body.phone ?? '').replace(/\D/g, '');
  if (!companyId || !phone) return reply.code(400).send({ error: 'company_id e phone são obrigatórios' });
  await pauseConversation(companyId, phone, Number(body.seconds) || env.humanPauseSeconds);
  return reply.send({ ok: true });
});

app.post('/internal/conversations/resume', async (request, reply) => {
  if (!authorized(request as any)) return reply.code(401).send({ error: 'unauthorized' });
  const body = (request.body ?? {}) as any;
  const companyId = String(body.company_id ?? '').trim();
  const phone = String(body.phone ?? '').replace(/\D/g, '');
  if (!companyId || !phone) return reply.code(400).send({ error: 'company_id e phone são obrigatórios' });
  await resumeConversation(companyId, phone);
  return reply.send({ ok: true });
});

await composeApplication(app);

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
