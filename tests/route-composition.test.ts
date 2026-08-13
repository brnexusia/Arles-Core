import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

vi.mock('ioredis', () => ({
  Redis: class RedisMock {}
}));

describe('route composition', () => {
  it('monta plataforma e Delivery sem rotas duplicadas', async () => {
    process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
    process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
    process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
    process.env.EVOLUTION_API_KEY ||= 'test-key';

    const [{ registerPlatformRoutes }, { registerDeliveryRoutes }] = await Promise.all([
      import('../src/platform/platform.routes.js'),
      import('../src/verticals/delivery/routes.js')
    ]);
    const app = Fastify();

    await registerPlatformRoutes(app);
    await registerDeliveryRoutes(app);
    await expect(app.ready()).resolves.toBe(app);

    expect(app.hasRoute({ method: 'GET', url: '/internal/platform/company' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/internal/verticals/delivery/orders' })).toBe(true);

    await app.close();
  });
});
