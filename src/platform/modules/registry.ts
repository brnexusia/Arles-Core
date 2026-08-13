import type { Company } from '../../core/types.js';
import type { VerticalModule } from './contract.js';

export class ModuleRegistry {
  private readonly modules = new Map<string, VerticalModule>();

  register(module: VerticalModule): void {
    const key = module.key.trim().toLowerCase();
    if (!key) throw new Error('MODULE_KEY_REQUIRED');
    if (this.modules.has(key)) throw new Error(`MODULE_ALREADY_REGISTERED:${key}`);
    if (!module.metadata?.name || !module.metadata?.version) {
      throw new Error(`MODULE_METADATA_INVALID:${key}`);
    }
    this.modules.set(key, { ...module, key });
  }

  get(key: string): VerticalModule | null {
    return this.modules.get(String(key).trim().toLowerCase()) ?? null;
  }

  list(): VerticalModule[] {
    return [...this.modules.values()];
  }

  defaultModule(): VerticalModule {
    const module = this.list()[0];
    if (!module) throw new Error('DEFAULT_MODULE_NOT_REGISTERED');
    return module;
  }

  resolveForCompany(company: Company): VerticalModule | null {
    const enabled = new Set(
      company.capabilities
        .filter(capability => capability.status === 'active')
        .map(capability => capability.key)
    );

    const capabilityMatch = this.list().find(module =>
      module.capabilities.some(capability => enabled.has(capability.key))
    );

    // companies.vertical permanece como projeção compatível durante a migração.
    return capabilityMatch ?? this.get(company.vertical);
  }

  resetForTests(): void {
    this.modules.clear();
  }
}

export const moduleRegistry = new ModuleRegistry();
