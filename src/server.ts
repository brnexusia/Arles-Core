import Fastify from 'fastify';
import { env } from './config/env.js';
import { checkDb } from './infrastructure/db.js';
import { redis } from './infrastructure/redis.js';
import { arlesEngine } from './core/engine.js';

const app = Fastify({
  logger: {
    level: env.logLevel
  }
});

app.get('/health', async () => {
  await checkDb();
  await redis.ping();

  return {
    ok: true,
    service: 'arles-engine',
    version: '0.1.0'
  };
});

app.post('/webhooks/evolution', async (request, reply) => {
  const payload = request.body;

  reply.code(202).send({ accepted: true });

  void arlesEngine
    .handleEvolution(payload)
    .catch(error => {
      request.log.error(
        { err: error },
        'Falha processando webhook Evolution'
      );
    });
});

await app.listen({
  host: '0.0.0.0',
  port: env.port
});
