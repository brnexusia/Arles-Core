import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

vi.mock('ioredis', () => ({
  Redis: class RedisMock {}
}));

describe('route composition', () => {
  it('monta a plataforma com somente Delivery', async () => {
    process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
    process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
    process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
    process.env.EVOLUTION_API_KEY ||= 'test-key';

    const { composeApplication } = await import('../src/composition.js');
    const app = Fastify();

    await composeApplication(app);
    await expect(app.ready()).resolves.toBe(app);

    expect(app.hasRoute({ method: 'GET', url: '/internal/platform/company' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/internal/verticals/delivery/orders' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/internal/verticals/beauty/appointments' })).toBe(false);
    expect(app.hasRoute({ method: 'GET', url: '/internal/verticals/cash/transactions' })).toBe(false);

    await app.close();
  });
});
