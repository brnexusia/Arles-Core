import { describe, expect, it } from 'vitest';
import { ModuleRegistry } from '../src/platform/modules/registry.js';
import type { Company } from '../src/core/types.js';

function company(capability: string): Company {
  return {
    id: 'tenant-a',
    name: 'Tenant A',
    slug: 'tenant-a',
    vertical: 'legacy-projection',
    evolution_instance: 'tenant-a-instance',
    subscription_status: 'active',
    access_active: true,
    trial_ends_at: null,
    timezone: 'America/Sao_Paulo',
    capabilities: [{ key: capability, status: 'active', configuration: {} }]
  };
}

describe('module registry', () => {
  it('registra uma vertical falsa com todos os pontos de extensão sem alterar o kernel', async () => {
    const registry = new ModuleRegistry();
    const fake = {
      key: 'test-module',
      metadata: { name: 'Test Module', version: '1.0.0' },
      capabilities: [{ key: 'vertical.test' }],
      conversationHandler: { handle: async () => ({ actions: [{ type: 'text' as const, text: 'ok' }] }) },
      registerRoutes: async () => undefined,
      events: ['test.event'],
      onboardingSteps: [{
        key: 'test.setup',
        scope: 'capability' as const,
        capabilityKey: 'vertical.test',
        title: 'Setup test',
        order: 1
      }],
      configuration: { enabled: true },
      ui: { entry: 'test', navigation: [{ key: 'demo', label: 'Demo', order: 1 }] }
    };

    registry.register(fake);
    expect(registry.resolveForCompany(company('vertical.test'))?.key).toBe('test-module');
    expect(await fake.conversationHandler.handle()).toEqual({ actions: [{ type: 'text', text: 'ok' }] });
    expect(registry.get('test-module')?.events).toContain('test.event');
    expect(registry.get('test-module')?.onboardingSteps?.[0]?.key).toBe('test.setup');
    expect(registry.get('test-module')?.ui?.entry).toBe('test');
  });

  it('rejeita chaves duplicadas e mantém projeção vertical como fallback', () => {
    const registry = new ModuleRegistry();
    const module = {
      key: 'legacy-projection',
      metadata: { name: 'Legacy', version: '1.0.0' },
      capabilities: [{ key: 'vertical.legacy' }]
    };
    registry.register(module);
    expect(() => registry.register(module)).toThrow('MODULE_ALREADY_REGISTERED');
    expect(registry.resolveForCompany(company('unrelated'))?.key).toBe('legacy-projection');
  });
});
